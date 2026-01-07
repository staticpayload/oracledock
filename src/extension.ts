/**
 * Oracle Dock - VS Code Extension Entry Point
 * 
 * Architecture:
 * - WebviewViewProvider registers a sidebar panel titled "Oracle Dock"
 * - Supports multiple parallel PTY sessions with unique sessionIds
 * - Session registry maintains all active sessions with isolated lifecycles
 * - Each session owns: sessionId, command, PTY instance, output buffer, state
 * - Webview manages multiple xterm instances, one active at a time
 * 
 * Key decisions:
 * - node-pty instead of child_process: Provides full TTY emulation (ANSI, cursor, etc.)
 * - No shell wrapping: Command is spawned directly to avoid shell injection risks
 * - Unmodified process.env: Inherits user's full environment for PATH resolution
 * - HOME as cwd: Matches user expectation from Terminal.app
 * - Sessions persist independently: killing one does not affect others
 */

import * as vscode from 'vscode';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import * as pty from 'node-pty';
import { execFile } from 'child_process';

// ========== SECURITY LIMITS ==========
// These constants enforce hard limits to prevent resource exhaustion attacks

/** Maximum concurrent PTY sessions to prevent session bomb attacks */
const MAX_SESSIONS = 20;

/** Maximum output buffer size per session (5MB) to prevent memory exhaustion */
const MAX_OUTPUT_BUFFER_BYTES = 5_000_000;

/** Maximum lines to keep in output buffer to bound memory growth */
const MAX_OUTPUT_BUFFER_LINES = 10_000;

/** Maximum number of arguments per spawn command */
const MAX_ARG_COUNT = 50;

/** Maximum length of a single argument in bytes */
const MAX_ARG_LENGTH = 4096;

/** Whitelist pattern for command names - alphanumeric, dash, underscore only
 *  No paths, no shell metacharacters, no path traversal */
const COMMAND_REGEX = /^[a-zA-Z0-9_\-]+$/;

/** Supported agent CLIs (hardcoded, always visible) */
const ALLOWED_AGENTS = new Set([
  'claude',
  'codex',
  'gemini',
  'droid',
  'kiro-cli',
  'kilocode',
  'opencode',
  'aider'
]);

const LOGIN_ENV_TIMEOUT_MS = 5000;
const LOGIN_ENV_MAX_BUFFER = 1024 * 1024;

let cachedLoginEnv: NodeJS.ProcessEnv | null = null;
let loginEnvPromise: Promise<NodeJS.ProcessEnv> | null = null;

function parseEnvOutput(output: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    if (!line) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx);
    const value = line.slice(idx + 1);
    result[key] = value;
  }
  return result;
}

function resolveLoginShellEnv(): Promise<NodeJS.ProcessEnv> {
  if (cachedLoginEnv) return Promise.resolve(cachedLoginEnv);
  if (loginEnvPromise) return loginEnvPromise;

  const shell = process.env.SHELL;
  if (!shell) {
    cachedLoginEnv = { ...process.env };
    return Promise.resolve(cachedLoginEnv);
  }

  loginEnvPromise = new Promise((resolve) => {
    execFile(shell, ['-ilc', 'env'], {
      env: process.env,
      timeout: LOGIN_ENV_TIMEOUT_MS,
      maxBuffer: LOGIN_ENV_MAX_BUFFER
    }, (error, stdout) => {
      if (error || !stdout) {
        cachedLoginEnv = { ...process.env };
        resolve(cachedLoginEnv);
        return;
      }
      const parsed = parseEnvOutput(stdout);
      cachedLoginEnv = { ...process.env, ...parsed };
      resolve(cachedLoginEnv);
    });
  });

  return loginEnvPromise;
}

function toSpawnEnv(env: NodeJS.ProcessEnv): { [key: string]: string } {
  const result: { [key: string]: string } = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') {
      result[key] = value;
    }
  }
  return result;
}

function ensureSpawnHelperExecutable(): void {
  if (process.platform === 'win32') return;

  let moduleRoot: string;
  try {
    moduleRoot = path.dirname(require.resolve('node-pty/package.json'));
  } catch (err) {
    console.warn('[OracleDock] node-pty package not found for spawn-helper fix:', err);
    return;
  }

  const candidates = [
    path.join(moduleRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'),
    path.join(moduleRoot, 'build', 'Release', 'spawn-helper'),
    path.join(moduleRoot, 'build', 'Debug', 'spawn-helper')
  ];

  for (const helperPath of candidates) {
    try {
      if (!fs.existsSync(helperPath)) continue;
      const stat = fs.statSync(helperPath);
      const mode = stat.mode & 0o777;
      if ((mode & 0o111) === 0) {
        fs.chmodSync(helperPath, mode | 0o111);
      }
    } catch (err) {
      console.warn(`[OracleDock] Failed to ensure spawn-helper permissions at ${helperPath}:`, err);
    }
  }
}

/** Valid IPC message types from Webview - reject all others */
const VALID_MESSAGE_TYPES = new Set([
  'spawnSession', 'spawnSessionWithArgs', 'writeInput',
  'resizeSession', 'killSession', 'focusSession',
  'requestPersistedState', 'persistSessions', 'setActiveSession'
]);

// Maximum dimensions for terminal resize to prevent integer overflow
const MAX_TERMINAL_COLS = 500;
const MAX_TERMINAL_ROWS = 200;

// Session lifecycle states
type SessionState = 'running' | 'exited' | 'crashed';

// Session data structure - each session is fully isolated
// SECURITY: Includes disposal tracking and listener references for proper cleanup
interface Session {
  sessionId: string;
  command: string;
  args: string[];                   // Arguments passed to the command
  pty: pty.IPty;
  outputBuffer: string[];           // Stores output for replay when switching sessions
  outputBufferBytes: number;        // Track total bytes for memory limiting
  state: SessionState;
  exitCode?: number;
  disposed: boolean;                // SECURITY: Prevent double-dispose
  dataDisposable?: pty.IDisposable; // SECURITY: PTY data listener for cleanup
  exitDisposable?: pty.IDisposable; // SECURITY: PTY exit listener for cleanup
}

// ========== Persistence Data Models ==========

// Maximum lines to persist per session output snapshot
const OUTPUT_SNAPSHOT_MAX_LINES = 1000;

// Persisted session - serializable session metadata + output snapshot
// Note: Does NOT include PTY handle (not serializable, not resurrectable)
interface PersistedSession {
  sessionId: string;
  command: string;
  args: string[];
  state: SessionState;
  exitCode?: number;
  outputSnapshot: string[];  // Last N lines of output
}

// Full persisted state structure
interface PersistedState {
  sessions: PersistedSession[];
  activeSessionId: string | null;
}

// Message types for Webview -> Extension communication
// spawnSessionWithArgs: Launch agent CLI with explicit args array
// Persistence: requestPersistedState, persistSessions, setActiveSession
interface WebviewMessage {
  type: 'spawnSession' | 'spawnSessionWithArgs' | 'writeInput' | 'resizeSession' | 'killSession' | 'focusSession' | 'requestPersistedState' | 'persistSessions' | 'setActiveSession';
  command?: string;       // For spawn: the CLI command/executable
  args?: string[];        // For 'spawnSessionWithArgs': arguments array
  sessionId?: string;     // For session-specific operations
  data?: string;          // For 'writeInput': keyboard data from xterm
  cols?: number;          // For 'resizeSession': terminal columns
  rows?: number;          // For 'resizeSession': terminal rows
  sessions?: PersistedSession[];   // For 'persistSessions': sessions to save
}

// Message types for Extension -> Webview communication
// restoreState: Persistence - sends stored state to Webview on init
interface ExtensionMessage {
  type: 'sessionStarted' | 'sessionOutput' | 'sessionExited' | 'sessionKilled' | 'error' | 'ready' | 'restoreState';
  sessionId?: string;     // Session identifier
  command?: string;       // For 'sessionStarted': the command
  args?: string[];        // For 'sessionStarted': the arguments passed
  data?: string;          // For 'sessionOutput': PTY output chunk
  code?: number;          // For 'sessionExited': process exit code
  message?: string;       // For 'error': error description
  sessions?: PersistedSession[];
  activeSessionId?: string | null;
}

/**
 * OracleDockViewProvider
 * 
 * Implements WebviewViewProvider to create a sidebar panel.
 * Manages multiple parallel PTY sessions via a session registry.
 * Each session is fully isolated with its own PTY, buffer, and state.
 */
class OracleDockViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'oracledock.sidebarView';

  // Storage key for workspaceState persistence
  private static readonly STORAGE_KEY = 'oracledock.persistedState';

  private _view?: vscode.WebviewView;
  private readonly _launchEnv: NodeJS.ProcessEnv;

  // Session registry - maps sessionId to Session object
  // Maintains all active sessions with isolated lifecycles
  private _sessions: Map<string, Session> = new Map();

  // Counter for generating unique session IDs
  private _sessionCounter = 0;
  private readonly _workspaceKey: string;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext,
    launchEnv: NodeJS.ProcessEnv
  ) {
    this._launchEnv = launchEnv;
    const workspacePath = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || 'no-workspace';
    this._workspaceKey = `${OracleDockViewProvider.STORAGE_KEY}:${workspacePath}`;
  }

  /**
   * Called when the Webview becomes visible.
   * Sets up the HTML content and message handlers.
   */
  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    // Configure Webview capabilities
    webviewView.webview.options = {
      enableScripts: true,  // Required for xterm.js
      localResourceRoots: [this._extensionUri]  // Security: restrict resource access
    };

    // Set the HTML content
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Handle messages from Webview
    webviewView.webview.onDidReceiveMessage(
      (message: WebviewMessage) => this._handleMessage(message),
      undefined,
      []
    );

    // Cleanup all PTYs when Webview is disposed (sidebar closed)
    webviewView.onDidDispose(() => {
      this._killAllSessions();
    });

    // Signal to Webview that extension is ready
    this._postMessage({ type: 'ready' });
  }

  /**
   * Handle incoming messages from Webview.
   * 
   * SECURITY: All messages are validated before processing:
   * - Message type must be in whitelist
   * - Payload fields are type-checked
   * - sessionId format is validated
   * - Resize dimensions are bounded
   * 
   * Protocol:
   * - spawnSession: Create new PTY session with command (legacy, parses args from string)
   * - spawnSessionWithArgs: Create new PTY session with explicit command + args array
   * - writeInput: Forward keyboard input to specific session's PTY
   * - resizeSession: Adjust specific session's PTY dimensions
   * - killSession: Terminate specific session
   * - focusSession: Request session data replay for switching
   * - requestPersistedState: Restore stored sessions and active session
   * - persistSessions: Persist session metadata and output snapshots
   * - setActiveSession: Persist active session ID
   */
  private _handleMessage(message: WebviewMessage): void {
    // SECURITY: Reject null/undefined messages
    if (!message || typeof message !== 'object') {
      console.warn('[OracleDock] Rejected null/invalid message');
      return;
    }

    // SECURITY: Reject unknown message types (whitelist approach)
    if (typeof message.type !== 'string' || !VALID_MESSAGE_TYPES.has(message.type)) {
      console.warn('[OracleDock] Rejected unknown message type:', message.type);
      return;
    }

    // SECURITY: Validate sessionId format when present
    if (message.sessionId !== undefined) {
      if (typeof message.sessionId !== 'string' || message.sessionId.length > 100) {
        console.warn('[OracleDock] Rejected invalid sessionId');
        return;
      }
    }

    // SECURITY: Validate data when present
    if (message.data !== undefined && typeof message.data !== 'string') {
      console.warn('[OracleDock] Rejected invalid data field');
      return;
    }

    switch (message.type) {
      case 'spawnSession':
        // Direct spawn for agent CLI with empty args
        if (message.command && typeof message.command === 'string') {
          this._spawnSessionWithArgs(message.command.trim(), []);
        }
        break;

      case 'spawnSessionWithArgs':
        // Explicit command + args array for agent launch
        if (message.command && typeof message.command === 'string') {
          const args = Array.isArray(message.args) ? message.args : [];
          this._spawnSessionWithArgs(message.command, args);
        }
        break;

      case 'writeInput':
        if (message.sessionId && message.data) {
          const session = this._sessions.get(message.sessionId);
          // SECURITY: Only write to running, non-disposed sessions
          if (session && session.state === 'running' && !session.disposed) {
            // Forward raw input to PTY - xterm handles escape sequences
            session.pty.write(message.data);
          }
        }
        break;

      case 'resizeSession':
        // SECURITY: Validate cols/rows are numbers within bounds
        if (message.sessionId &&
          typeof message.cols === 'number' &&
          typeof message.rows === 'number' &&
          Number.isInteger(message.cols) &&
          Number.isInteger(message.rows) &&
          message.cols > 0 && message.cols <= MAX_TERMINAL_COLS &&
          message.rows > 0 && message.rows <= MAX_TERMINAL_ROWS) {
          const session = this._sessions.get(message.sessionId);
          // SECURITY: Only resize running, non-disposed sessions
          if (session && session.state === 'running' && !session.disposed) {
            session.pty.resize(message.cols, message.rows);
          }
        }
        break;

      case 'killSession':
        if (message.sessionId) {
          this._killSession(message.sessionId);
        }
        break;

      case 'focusSession':
        // No action needed on extension side - Webview handles xterm switching
        // Session output is already buffered and replayed client-side
        break;

      case 'requestPersistedState':
        // Persistence: Load and send stored state to Webview
        this._sendPersistedState();
        break;

      case 'persistSessions':
        // Persistence: Save sessions to workspaceState
        if (message.sessions) {
          this._persistSessions(message.sessions);
        }
        break;

      case 'setActiveSession':
        // Persistence: Save active session ID to workspaceState
        this._persistActiveSession(message.sessionId || null);
        break;
    }
  }

  // ========== Persistence Methods ==========

  /**
   * Load persisted state from workspaceState and send to Webview.
   * Called when Webview requests state on init.
   */
  private _sendPersistedState(): void {
    const state = this._context.workspaceState.get<PersistedState>(
      this._workspaceKey
    );

    // Send stored state or empty defaults
    this._postMessage({
      type: 'restoreState',
      sessions: state?.sessions || [],
      activeSessionId: state?.activeSessionId || null
    });
  }

  /**
   * Persist sessions to workspaceState.
   * Sessions are stored with output snapshots (trimmed to max lines).
   */
  private _persistSessions(sessions: PersistedSession[]): void {
    const state = this._context.workspaceState.get<PersistedState>(
      this._workspaceKey
    ) || { sessions: [], activeSessionId: null };

    // Ensure output snapshots don't exceed max size
    const trimmedSessions = sessions.map(s => ({
      ...s,
      outputSnapshot: s.outputSnapshot.slice(-OUTPUT_SNAPSHOT_MAX_LINES)
    }));

    state.sessions = trimmedSessions;
    this._context.workspaceState.update(this._workspaceKey, state);
  }

  /**
   * Persist active session ID to workspaceState.
   */
  private _persistActiveSession(sessionId: string | null): void {
    const state = this._context.workspaceState.get<PersistedState>(
      this._workspaceKey
    ) || { sessions: [], activeSessionId: null };

    state.activeSessionId = sessionId;
    this._context.workspaceState.update(this._workspaceKey, state);
  }

  /**
   * Create output snapshot from live session.
   * Trims to max lines and returns serializable array.
   */
  private _createOutputSnapshot(session: Session): string[] {
    // Join buffer into single string, split by lines, trim to max
    const fullOutput = session.outputBuffer.join('');
    const lines = fullOutput.split('\n');
    return lines.slice(-OUTPUT_SNAPSHOT_MAX_LINES);
  }

  /**
   * Persist current session state (called on session exit).
   * Updates the stored session with final state and output snapshot.
   */
  private _persistSessionState(session: Session): void {
    const state = this._context.workspaceState.get<PersistedState>(
      this._workspaceKey
    ) || { sessions: [], activeSessionId: null };

    // Find or create session entry
    const existingIndex = state.sessions.findIndex(s => s.sessionId === session.sessionId);
    const persistedSession: PersistedSession = {
      sessionId: session.sessionId,
      command: session.command,
      args: session.args,
      state: session.state,
      exitCode: session.exitCode,
      outputSnapshot: this._createOutputSnapshot(session)
    };

    if (existingIndex >= 0) {
      state.sessions[existingIndex] = persistedSession;
    } else {
      state.sessions.push(persistedSession);
    }

    this._context.workspaceState.update(this._workspaceKey, state);
  }

  /**
   * Generate a unique session ID.
   * Format: session-<counter>-<timestamp> for debugging clarity
   */
  private _generateSessionId(): string {
    return `session-${++this._sessionCounter}-${Date.now()}`;
  }

  /**
   * Spawn a new PTY session with explicit command and args array.
   * 
   * SECURITY HARDENING:
   * - Validates command against alphanumeric whitelist (no shell injection)
   * - Validates argument count and length
   * - Enforces session limit
   * - Tracks PTY listeners for cleanup
   * - Bounds output buffer size
   * 
   * Design decisions:
   * - Each session gets a unique sessionId
   * - Same command can be spawned multiple times (no reuse)
   * - No shell wrapping: spawns command directly with args array
   * - Uses login shell environment (merged over process.env)
   * - cwd is user HOME
   * - Output buffered for replay when switching sessions
   * - Args passed directly to node-pty (no shell expansion)
   */
  private _spawnSessionWithArgs(command: string, args: string[]): void {
    // SECURITY: Enforce session limit to prevent resource exhaustion
    if (this._sessions.size >= MAX_SESSIONS) {
      this._postMessage({
        type: 'error',
        message: `Maximum sessions (${MAX_SESSIONS}) reached. Kill existing sessions first.`
      });
      return;
    }

    // SECURITY: Validate command - alphanumeric only, no paths, no shell metacharacters
    if (!command || typeof command !== 'string' || !COMMAND_REGEX.test(command)) {
      this._postMessage({
        type: 'error',
        message: `Invalid command name: "${command}". Only alphanumeric characters, dashes, and underscores allowed.`
      });
      return;
    }

    // SECURITY: Validate args count
    if (args.length > MAX_ARG_COUNT) {
      this._postMessage({
        type: 'error',
        message: `Too many arguments (${args.length}). Maximum is ${MAX_ARG_COUNT}.`
      });
      return;
    }

    // SECURITY: Validate each arg - must be string, bounded length
    for (let i = 0; i < args.length; i++) {
      const arg = args[i];
      if (typeof arg !== 'string') {
        this._postMessage({
          type: 'error',
          message: `Invalid argument at position ${i}: not a string`
        });
        return;
      }
      if (arg.length > MAX_ARG_LENGTH) {
        this._postMessage({
          type: 'error',
          message: `Argument ${i} too long (${arg.length} bytes). Maximum is ${MAX_ARG_LENGTH}.`
        });
        return;
      }
    }

    if (!ALLOWED_AGENTS.has(command)) {
      this._postMessage({
        type: 'error',
        message: `Agent CLI not found in PATH: ${command}`
      });
      return;
    }

    const sessionId = this._generateSessionId();

    try {
      // Spawn PTY with:
      // - Command name (agent CLI)
      // - Args array passed directly (no shell parsing)
      // - User's HOME as working directory
      // - Login shell environment (merged over process.env)
      // - Default terminal size (will be resized by Webview)
      const ptyProcess = pty.spawn(command, args, {
        name: 'xterm-256color',  // Terminal type for ANSI support
        cols: 80,
        rows: 24,
        cwd: os.homedir(),       // User HOME as cwd
        env: toSpawnEnv(this._launchEnv)
      });

      // Create session object with command and args stored separately
      // SECURITY: Initialize with disposal tracking and byte counter
      const session: Session = {
        sessionId,
        command,
        args,
        pty: ptyProcess,
        outputBuffer: [],
        outputBufferBytes: 0,
        state: 'running',
        disposed: false
      };

      // Register session
      this._sessions.set(sessionId, session);

      // Notify Webview of new session with command and args
      this._postMessage({
        type: 'sessionStarted',
        sessionId,
        command,
        args
      });

      // Stream PTY output to Webview and buffer for replay
      // SECURITY: Store listener reference for cleanup
      const dataDisposable = ptyProcess.onData((data: string) => {
        // SECURITY: Check disposed flag before processing
        if (session.disposed) return;

        // SECURITY: Enforce output buffer byte limit
        if (session.outputBufferBytes + data.length > MAX_OUTPUT_BUFFER_BYTES) {
          // Drop oldest entries to make room (keep ~50% of limit)
          const targetSize = MAX_OUTPUT_BUFFER_BYTES / 2;
          while (session.outputBuffer.length > 0 && session.outputBufferBytes > targetSize) {
            const dropped = session.outputBuffer.shift();
            if (dropped) {
              session.outputBufferBytes -= dropped.length;
            }
          }
        }

        // SECURITY: Enforce line count limit
        if (session.outputBuffer.length >= MAX_OUTPUT_BUFFER_LINES) {
          // Remove oldest 10% of lines
          const toRemove = Math.ceil(MAX_OUTPUT_BUFFER_LINES * 0.1);
          const removed = session.outputBuffer.splice(0, toRemove);
          for (const chunk of removed) {
            session.outputBufferBytes -= chunk.length;
          }
        }

        // Buffer output for session switching replay
        session.outputBuffer.push(data);
        session.outputBufferBytes += data.length;

        // Stream to Webview
        this._postMessage({
          type: 'sessionOutput',
          sessionId,
          data
        });
      });

      // Handle PTY exit
      // SECURITY: Store listener reference for cleanup
      const exitDisposable = ptyProcess.onExit(({ exitCode }) => {
        // SECURITY: Check disposed flag - may have been killed already
        if (session.disposed) return;

        session.state = 'exited';
        session.exitCode = exitCode;

        // Persist session state with output snapshot
        this._persistSessionState(session);

        this._postMessage({
          type: 'sessionExited',
          sessionId,
          code: exitCode
        });
      });

      // SECURITY: Store disposables for cleanup
      session.dataDisposable = dataDisposable;
      session.exitDisposable = exitDisposable;

    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const notFound = /ENOENT|not found/i.test(rawMessage);
      this._postMessage({
        type: 'error',
        sessionId,
        message: notFound
          ? `Agent CLI not found in PATH: ${command}`
          : `Failed to spawn: ${rawMessage}`
      });
    }
  }

  /**
   * Terminate a specific session by sessionId.
   * Does not affect other running sessions.
   * 
   * SECURITY HARDENING:
   * - Guards against double-kill
   * - Disposes PTY listeners before killing
   * - Clears output buffer to free memory
   * - Wrapped in try-catch for safety
   */
  private _killSession(sessionId: string): void {
    const session = this._sessions.get(sessionId);
    if (!session) return;

    // SECURITY: Guard against double-kill
    if (session.disposed) {
      console.warn('[OracleDock] Session already disposed:', sessionId);
      return;
    }

    // SECURITY: Mark as disposed immediately to prevent race conditions
    session.disposed = true;

    // SECURITY: Dispose PTY listeners before killing to prevent callbacks
    try {
      session.dataDisposable?.dispose();
    } catch { /* ignore disposal errors */ }

    try {
      session.exitDisposable?.dispose();
    } catch { /* ignore disposal errors */ }

    // Kill PTY if still running
    if (session.state === 'running') {
      try {
        session.pty.kill();
      } catch { /* ignore kill errors - PTY may already be dead */ }
      session.state = 'exited';
    }

    // SECURITY: Clear output buffer to free memory
    session.outputBuffer.length = 0;
    session.outputBufferBytes = 0;

    // Remove from registry
    this._sessions.delete(sessionId);

    // Notify Webview
    this._postMessage({
      type: 'sessionKilled',
      sessionId
    });
  }

  /**
   * Terminate all sessions.
   * Called when Webview is disposed or extension deactivates.
   * 
   * SECURITY HARDENING:
   * - Uses _killSession for consistent cleanup
   * - Iterates over snapshot to avoid modification during iteration
   */
  private _killAllSessions(): void {
    // SECURITY: Create snapshot of session IDs to avoid modification during iteration
    const sessionIds = Array.from(this._sessions.keys());

    for (const sessionId of sessionIds) {
      this._killSession(sessionId);
    }

    // SECURITY: Ensure registry is cleared even if individual kills failed
    this._sessions.clear();
  }

  /**
   * Public dispose method for extension deactivation.
   * 
   * SECURITY: Ensures all PTYs are killed when extension deactivates.
   * Prevents orphan processes on VS Code reload/restart.
   */
  public dispose(): void {
    this._killAllSessions();
  }

  /**
   * Send a typed message to the Webview.
   */
  private _postMessage(message: ExtensionMessage): void {
    this._view?.webview.postMessage(message);
  }

  /**
   * Generate the HTML content for the Webview.
   * 
   * Structure:
   * - Left rail (60px): launcher + session icons
   * - Main panel: top bar (36px) + launcher/sessions surface
   * 
   * Security:
   * - Uses Content Security Policy with local bundled assets
   * - No CDN dependencies
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    const nonce = getNonce();

    // Get URIs for bundled xterm assets
    const xtermJsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'xterm.js'));
    const xtermCssUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'xterm.css'));
    const xtermFitUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'xterm-addon-fit.js'));
    const logoUris = {
      claude: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'Claude_Logo_2023_icon-s5120.ico')).toString(),
      codex: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'codex.ico')).toString(),
      gemini: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'gemini-color.ico')).toString(),
      droid: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'droid.svg')).toString(),
      'kiro-cli': webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'kiro-cli.svg')).toString(),
      kilocode: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'kilocode.svg')).toString(),
      opencode: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'opencode.png')).toString(),
      aider: webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'ico', 'aider.ico')).toString()
    };

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src ${webview.cspSource} 'nonce-${nonce}';
    font-src ${webview.cspSource};
    img-src ${webview.cspSource};
    connect-src ${webview.cspSource};
  ">
  <title>Oracle Dock</title>
  <link rel="stylesheet" href="${xtermCssUri}">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --font-ui: 12px;
      --font-mono: 13px;
    }

    html, body {
      height: 100%;
      width: 100%;
      overflow: hidden;
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size: var(--font-ui);
    }

    #app {
      display: flex;
      flex-direction: column;
      height: 100%;
      gap: 12px;
      padding: 12px;
      overflow: hidden;
    }

    #app-title {
      font-size: 14px;
      font-weight: 600;
    }

    .section {
      display: flex;
      flex-direction: column;
      gap: 6px;
      border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      padding-top: 10px;
    }

    .section:first-of-type {
      border-top: none;
      padding-top: 0;
    }

    .section-title {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      color: var(--vscode-descriptionForeground);
    }

    .launcher-row {
      display: flex;
      gap: 8px;
      align-items: center;
    }

    .agent-select {
      flex: 1;
      height: 32px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      padding: 0 8px;
      font-size: 13px;
    }

    .agent-launch {
      height: 32px;
      padding: 0 12px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      cursor: pointer;
      font-size: 12px;
    }

    .agent-launch:focus,
    .agent-select:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    #session-list {
      max-height: 180px;
      overflow-y: auto;
    }

    .list-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      cursor: pointer;
      text-align: left;
      font: inherit;
    }

    .list-item.active {
      border-color: var(--vscode-focusBorder);
      background: var(--vscode-list-activeSelectionBackground, rgba(0, 122, 204, 0.2));
    }

    .list-item:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .list-item .label {
      font-size: 13px;
    }

    .list-item .state {
      margin-left: auto;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }

    .logo {
      width: 22px;
      height: 22px;
      border-radius: 50%;
      overflow: hidden;
      background: var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      display: flex;
      align-items: center;
      justify-content: center;
      flex: 0 0 22px;
    }

    .logo img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .logo.empty img {
      display: none;
    }

    .kill-btn {
      margin-left: 8px;
      padding: 2px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: transparent;
      color: var(--vscode-editor-foreground);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }

    .kill-btn svg {
      width: 12px;
      height: 12px;
    }

    .kill-btn:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }

    .confirm-btn {
      margin-left: 6px;
      padding: 2px 6px;
      font-size: 11px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: transparent;
      color: var(--vscode-editor-foreground);
      cursor: pointer;
    }

    .confirm-btn.danger {
      color: var(--vscode-errorForeground, #f14c4c);
      border-color: var(--vscode-errorForeground, #f14c4c);
    }

    .empty-state {
      color: var(--vscode-descriptionForeground);
      cursor: default;
    }

    #terminal-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
      min-height: 0;
      border-top: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      padding-top: 10px;
    }

    #active-session {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
    }

    #terminal-surface {
      position: relative;
      flex: 1;
      min-height: 0;
      border-radius: 6px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: var(--vscode-editor-background);
      overflow: hidden;
    }

    .terminal-wrapper {
      position: absolute;
      inset: 0;
    }

    .terminal-wrapper.hidden {
      display: none;
    }

    #fatal-error,
    #ui-error {
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--vscode-errorForeground, #f14c4c);
      color: var(--vscode-errorForeground, #f14c4c);
      background: rgba(241, 76, 76, 0.08);
    }

    #fatal-error.hidden,
    #ui-error.hidden {
      display: none;
    }

    #fatal-error button {
      margin-top: 6px;
      padding: 4px 8px;
      font-size: 12px;
      border-radius: 4px;
      border: 1px solid var(--vscode-panel-border, rgba(128, 128, 128, 0.2));
      background: transparent;
      color: var(--vscode-editor-foreground);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div id="app">
    <div id="app-title">Oracle Dock</div>
    <div id="ui-error" class="hidden" role="alert" aria-live="polite"></div>
    <div id="fatal-error" class="hidden" role="alert" aria-live="assertive">
      <div class="error-title">Oracle Dock failed to load</div>
      <div id="fatal-error-message">An unexpected error occurred.</div>
      <button id="fatal-error-reload" type="button">Reload</button>
    </div>

    <section class="section">
      <div class="section-title">Agent</div>
      <div class="launcher-row">
        <select id="agent-select" class="agent-select" aria-label="Agent selector"></select>
        <button id="agent-launch" class="agent-launch" type="button">Launch</button>
      </div>
    </section>

    <section class="section">
      <div class="section-title">Sessions</div>
      <div id="session-list" class="list"></div>
    </section>

    <section class="section" id="terminal-section">
      <div class="section-title">Active Session</div>
      <div id="active-session">
        <span class="logo empty" id="active-session-logo">
          <img id="active-session-logo-img" alt="">
        </span>
        <div id="active-session-label">No active session</div>
      </div>
      <div id="terminal-surface"></div>
    </section>
  </div>

  <script src="${xtermJsUri}"></script>
  <script src="${xtermFitUri}"></script>

  <script nonce="${nonce}">
    (function() {
      const appContainer = document.getElementById('app');
      const fatalOverlay = document.getElementById('fatal-error');
      const fatalMessage = document.getElementById('fatal-error-message');
      const fatalReload = document.getElementById('fatal-error-reload');
      const uiError = document.getElementById('ui-error');

      function showFatalError(message) {
        console.error('[OracleDock Webview] Fatal error:', message);
        if (fatalMessage) fatalMessage.textContent = message;
        if (fatalOverlay) fatalOverlay.classList.remove('hidden');
        if (appContainer) appContainer.setAttribute('aria-hidden', 'true');
      }

      window.addEventListener('error', (event) => {
        showFatalError(event.message || 'Script error');
      });

      window.addEventListener('unhandledrejection', (event) => {
        const reason = event && event.reason ? String(event.reason) : 'Unhandled promise rejection';
        showFatalError(reason);
      });

      if (fatalReload) {
        fatalReload.addEventListener('click', () => {
          location.reload();
        });
      }

      if (typeof acquireVsCodeApi !== 'function') {
        showFatalError('VS Code API unavailable. Reload the window.');
        return;
      }

      if (typeof Terminal !== 'function' || !window.FitAddon || typeof window.FitAddon.FitAddon !== 'function') {
        showFatalError('xterm.js failed to load. Check the extension media assets.');
        return;
      }

      const vscode = acquireVsCodeApi();

      const MAX_CLIENT_BUFFER_LINES = 5000;
      const VALID_EXTENSION_MESSAGES = new Set([
        'sessionStarted', 'sessionOutput', 'sessionExited', 'sessionKilled',
        'error', 'ready', 'restoreState'
      ]);

      const agentSelect = document.getElementById('agent-select');
      const agentLaunch = document.getElementById('agent-launch');
      const sessionList = document.getElementById('session-list');
      const terminalSurface = document.getElementById('terminal-surface');
      const activeSessionLogo = document.getElementById('active-session-logo');
      const activeSessionLogoImg = document.getElementById('active-session-logo-img');
      const activeSessionLabel = document.getElementById('active-session-label');

      const AGENT_CLIS = [
        'claude',
        'codex',
        'gemini',
        'droid',
        'kiro-cli',
        'kilocode',
        'opencode',
        'aider'
      ];

      const AGENT_LOGOS = ${JSON.stringify(logoUris)};

      const sessions = new Map();
      let activeSessionId = null;
      const pendingKills = new Set();
      const missingAgents = new Set();

      function persistSessions() {
        const sessionsArray = Array.from(sessions.values()).map(s => ({
          sessionId: s.sessionId,
          command: s.command,
          args: s.args || [],
          state: s.state,
          exitCode: s.exitCode,
          outputSnapshot: s.outputBuffer || []
        }));
        vscode.postMessage({ type: 'persistSessions', sessions: sessionsArray });
      }

      function persistActiveSession() {
        vscode.postMessage({ type: 'setActiveSession', sessionId: activeSessionId });
      }

      function requestPersistedState() {
        vscode.postMessage({ type: 'requestPersistedState' });
      }

      function showUiError(message) {
        if (!uiError) return;
        uiError.textContent = message;
        uiError.classList.remove('hidden');
      }

      function clearUiError() {
        if (!uiError) return;
        uiError.textContent = '';
        uiError.classList.add('hidden');
      }

      function formatAgentLabel(command) {
        return command.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
      }

      function buildLogo(command, label) {
        const wrapper = document.createElement('span');
        wrapper.className = 'logo';

        const img = document.createElement('img');
        const src = AGENT_LOGOS[command];
        if (src) {
          img.src = src;
          img.alt = label + ' logo';
        } else {
          wrapper.classList.add('empty');
          img.alt = '';
        }
        wrapper.appendChild(img);
        return wrapper;
      }

      function populateAgentSelect() {
        const selected = agentSelect.value;
        agentSelect.innerHTML = '';
        for (const command of AGENT_CLIS) {
          const option = document.createElement('option');
          option.value = command;
          const label = formatAgentLabel(command);
          option.textContent = missingAgents.has(command)
            ? label + ' (not installed)'
            : label;
          agentSelect.appendChild(option);
        }
        if (selected && AGENT_CLIS.includes(selected)) {
          agentSelect.value = selected;
        }
      }

      function spawnCommand(command) {
        if (!command) return;
        clearUiError();
        vscode.postMessage({
          type: 'spawnSession',
          command: command
        });
      }

      function renderSessionList() {
        sessionList.innerHTML = '';

        if (sessions.size === 0) {
          const empty = document.createElement('div');
          empty.className = 'list-item empty-state';
          empty.textContent = 'No sessions yet';
          sessionList.appendChild(empty);
          return;
        }

        const counts = new Map();
        for (const [sessionId, session] of sessions) {
          const count = (counts.get(session.command) || 0) + 1;
          counts.set(session.command, count);

          const labelText = formatAgentLabel(session.command) + ' #' + count;
          const item = document.createElement('div');
          item.className = 'list-item';
          item.setAttribute('role', 'button');
          item.setAttribute('tabindex', '0');
          if (sessionId === activeSessionId) {
            item.classList.add('active');
          }

          item.appendChild(buildLogo(session.command, formatAgentLabel(session.command)));

          const label = document.createElement('span');
          label.className = 'label';
          label.textContent = labelText;
          item.appendChild(label);

          const state = document.createElement('span');
          state.className = 'state';
          state.textContent = session.state;
          item.appendChild(state);

          const killButton = document.createElement('button');
          killButton.type = 'button';
          killButton.className = 'kill-btn';
          killButton.setAttribute('aria-label', 'Kill session');
          killButton.innerHTML = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4l8 8M12 4l-8 8"/></svg>';
          killButton.addEventListener('click', (event) => {
            event.stopPropagation();
            pendingKills.add(sessionId);
            renderSessionList();
          });
          item.appendChild(killButton);

          if (pendingKills.has(sessionId)) {
            const confirmBtn = document.createElement('button');
            confirmBtn.type = 'button';
            confirmBtn.className = 'confirm-btn danger';
            confirmBtn.textContent = 'Confirm';
            confirmBtn.addEventListener('click', (event) => {
              event.stopPropagation();
              pendingKills.delete(sessionId);
              killSession(sessionId);
            });
            item.appendChild(confirmBtn);

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'confirm-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', (event) => {
              event.stopPropagation();
              pendingKills.delete(sessionId);
              renderSessionList();
            });
            item.appendChild(cancelBtn);
          }

          item.addEventListener('click', () => {
            switchToSession(sessionId, true);
          });
          item.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
              event.preventDefault();
              switchToSession(sessionId, true);
            }
          });

          sessionList.appendChild(item);
        }
      }

      function updateActiveSessionHeader() {
        if (!activeSessionId || !sessions.has(activeSessionId)) {
          activeSessionLabel.textContent = 'No active session';
          activeSessionLogo.classList.add('empty');
          activeSessionLogoImg.removeAttribute('src');
          activeSessionLogoImg.alt = '';
          return;
        }

        const session = sessions.get(activeSessionId);
        const label = getSessionDisplayName(activeSessionId);
        activeSessionLabel.textContent = label;

        const logoSrc = AGENT_LOGOS[session.command];
        if (logoSrc) {
          activeSessionLogo.classList.remove('empty');
          activeSessionLogoImg.src = logoSrc;
          activeSessionLogoImg.alt = formatAgentLabel(session.command) + ' logo';
        } else {
          activeSessionLogo.classList.add('empty');
          activeSessionLogoImg.removeAttribute('src');
          activeSessionLogoImg.alt = '';
        }
      }

      function getSessionDisplayName(sessionId) {
        const counts = new Map();
        for (const [id, session] of sessions) {
          const count = (counts.get(session.command) || 0) + 1;
          counts.set(session.command, count);
          if (id === sessionId) {
            return formatAgentLabel(session.command) + ' #' + count;
          }
        }
        const session = sessions.get(sessionId);
        return session ? formatAgentLabel(session.command) : 'Unknown Session';
      }

      function createTerminalForSession(sessionId) {
        const terminal = new Terminal({
          cursorBlink: true,
          fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
          fontSize: 13,
          theme: {
            background: getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e',
            foreground: getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4',
            cursor: '#aeafad',
            cursorAccent: '#1e1e1e',
            selectionBackground: 'rgba(255, 255, 255, 0.3)'
          }
        });

        const fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);

        const wrapper = document.createElement('div');
        wrapper.className = 'terminal-wrapper hidden';
        wrapper.id = 'terminal-' + sessionId;
        terminalSurface.appendChild(wrapper);

        terminal.open(wrapper);

        terminal.onData(data => {
          vscode.postMessage({
            type: 'writeInput',
            sessionId: sessionId,
            data: data
          });
        });

        return { terminal, fitAddon, wrapper };
      }

      function createRestoredTerminal(sessionId, outputSnapshot) {
        const terminal = new Terminal({
          cursorBlink: false,
          fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace",
          fontSize: 13,
          disableStdin: true,
          theme: {
            background: getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim() || '#1e1e1e',
            foreground: getComputedStyle(document.body).getPropertyValue('--vscode-editor-foreground').trim() || '#d4d4d4',
            cursor: '#aeafad'
          }
        });

        const fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);

        const wrapper = document.createElement('div');
        wrapper.className = 'terminal-wrapper hidden';
        wrapper.id = 'terminal-' + sessionId;
        terminalSurface.appendChild(wrapper);

        terminal.open(wrapper);

        if (outputSnapshot && outputSnapshot.length > 0) {
          terminal.write(outputSnapshot.join('\\n'));
          terminal.write('\\r\\n\\x1b[90m[Session restored - output is read-only]\\x1b[0m\\r\\n');
        } else {
          terminal.write('\\x1b[90m[No output snapshot available]\\x1b[0m\\r\\n');
        }

        return { terminal, fitAddon, wrapper };
      }

      function switchToSession(sessionId, force) {
        if (!force && activeSessionId === sessionId) return;

        if (activeSessionId && sessions.has(activeSessionId)) {
          const current = sessions.get(activeSessionId);
          if (current.wrapper) {
            current.wrapper.classList.add('hidden');
          }
        }

        const session = sessions.get(sessionId);
        if (session) {
          session.wrapper.classList.remove('hidden');
          activeSessionId = sessionId;

          requestAnimationFrame(() => {
            session.fitAddon.fit();
            sendResize(sessionId, session.terminal);
            session.terminal.focus();
          });
        }

        renderSessionList();
        updateActiveSessionHeader();

        vscode.postMessage({ type: 'focusSession', sessionId });
        persistActiveSession();
      }

      function sendResize(sessionId, terminal) {
        vscode.postMessage({
          type: 'resizeSession',
          sessionId: sessionId,
          cols: terminal.cols,
          rows: terminal.rows
        });
      }

      function killSession(sessionId) {
        vscode.postMessage({ type: 'killSession', sessionId });
      }

      function removeSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;

        if (session.terminal) {
          session.terminal.dispose();
        }
        if (session.wrapper) {
          session.wrapper.remove();
        }

        sessions.delete(sessionId);
        pendingKills.delete(sessionId);

        if (activeSessionId === sessionId) {
          activeSessionId = null;
          const remaining = Array.from(sessions.keys());
          if (remaining.length > 0) {
            switchToSession(remaining[0], true);
          }
        }

        renderSessionList();
        updateActiveSessionHeader();
        persistSessions();
      }

      const resizeObserver = new ResizeObserver(() => {
        if (activeSessionId && sessions.has(activeSessionId)) {
          const session = sessions.get(activeSessionId);
          requestAnimationFrame(() => {
            session.fitAddon.fit();
            sendResize(activeSessionId, session.terminal);
          });
        }
      });
      resizeObserver.observe(terminalSurface);

      window.addEventListener('message', (event) => {
        const message = event.data;

        if (!message || typeof message !== 'object') {
          console.warn('[OracleDock Webview] Ignored invalid message');
          return;
        }

        if (typeof message.type !== 'string' || !VALID_EXTENSION_MESSAGES.has(message.type)) {
          return;
        }

        switch (message.type) {
          case 'sessionStarted': {
            const { sessionId, command, args } = message;
            if (typeof sessionId !== 'string' || typeof command !== 'string') {
              console.warn('[OracleDock Webview] Invalid sessionStarted message');
              break;
            }

            if (sessions.has(sessionId)) {
              console.warn('[OracleDock Webview] Duplicate session ignored:', sessionId);
              break;
            }

            const { terminal, fitAddon, wrapper } = createTerminalForSession(sessionId);
            sessions.set(sessionId, {
              sessionId,
              command,
              args: Array.isArray(args) ? args : [],
              terminal,
              fitAddon,
              wrapper,
              state: 'running',
              outputBuffer: []
            });

            missingAgents.delete(command);
            populateAgentSelect();
            clearUiError();

            switchToSession(sessionId, true);
            persistSessions();
            break;
          }

          case 'sessionOutput': {
            const { sessionId, data } = message;
            if (typeof sessionId !== 'string' || typeof data !== 'string') break;

            const session = sessions.get(sessionId);
            if (session && data) {
              if (session.outputBuffer.length >= MAX_CLIENT_BUFFER_LINES) {
                const toRemove = Math.ceil(MAX_CLIENT_BUFFER_LINES * 0.1);
                session.outputBuffer.splice(0, toRemove);
              }

              session.outputBuffer.push(data);
              session.terminal.write(data);
            }
            break;
          }

          case 'sessionExited': {
            const { sessionId, code } = message;
            const session = sessions.get(sessionId);
            if (session) {
              session.state = 'exited';
              session.exitCode = code;
              session.terminal.write('\\r\\n\\x1b[90m[Process exited with code ' + code + ']\\x1b[0m\\r\\n');
              renderSessionList();
              updateActiveSessionHeader();
              persistSessions();
            }
            break;
          }

          case 'sessionKilled': {
            const { sessionId } = message;
            removeSession(sessionId);
            break;
          }

          case 'error': {
            const text = message.message || 'Unexpected error';
            console.error('Oracle Dock Error:', text);
            const match = text.match(/Agent CLI not found in PATH:\\s*([^\\s]+)/i);
            if (match) {
              const command = match[1];
              missingAgents.add(command);
              populateAgentSelect();
              showUiError('Not installed: ' + formatAgentLabel(command));
            } else {
              showUiError(text);
            }
            break;
          }

          case 'ready': {
            requestPersistedState();
            break;
          }

          case 'restoreState': {
            const { sessions: restoredSessions, activeSessionId: restoredActiveId } = message;

            if (restoredSessions && restoredSessions.length > 0) {
              for (const s of restoredSessions) {
                if (sessions.has(s.sessionId)) continue;

                const { terminal, fitAddon, wrapper } = createRestoredTerminal(
                  s.sessionId,
                  s.outputSnapshot || []
                );

                sessions.set(s.sessionId, {
                  sessionId: s.sessionId,
                  command: s.command,
                  args: s.args || [],
                  terminal,
                  fitAddon,
                  wrapper,
                  state: 'exited',
                  exitCode: s.exitCode,
                  outputBuffer: s.outputSnapshot || [],
                  restored: true
                });
              }
            }

            if (restoredActiveId && sessions.has(restoredActiveId)) {
              activeSessionId = restoredActiveId;
            } else if (sessions.size > 0) {
              activeSessionId = Array.from(sessions.keys())[0];
            }

            renderSessionList();
            updateActiveSessionHeader();
            if (activeSessionId) {
              switchToSession(activeSessionId, true);
            }
            break;
          }
        }
      });

      agentLaunch.addEventListener('click', () => {
        spawnCommand(agentSelect.value);
      });
      agentSelect.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          spawnCommand(agentSelect.value);
        }
      });

      const initUi = () => {
        populateAgentSelect();
        renderSessionList();
        updateActiveSessionHeader();
      };

      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initUi);
      } else {
        initUi();
      }
    })();
  </script>
</body>
</html>`;
  }
}

/**
 * Generate a random nonce for Content Security Policy.
 * Ensures only scripts with this nonce can execute.
 */
function getNonce(): string {
  let text = '';
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

// SECURITY: Singleton reference for deactivation cleanup
let providerInstance: OracleDockViewProvider | null = null;

/**
 * Extension activation.
 * Called when the extension is first activated (e.g., sidebar opened).
 * 
 * SECURITY: Stores provider instance for deactivation cleanup.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  ensureSpawnHelperExecutable();

  // Resolve login shell environment once on activation
  const launchEnv = await resolveLoginShellEnv();

  // Register the WebviewViewProvider for the sidebar
  // Pass context for workspaceState persistence
  const provider = new OracleDockViewProvider(context.extensionUri, context, launchEnv);

  // SECURITY: Store singleton reference for deactivation
  providerInstance = provider;

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      OracleDockViewProvider.viewType,
      provider,
      {
        // Retain Webview state when hidden to preserve PTY session
        webviewOptions: { retainContextWhenHidden: true }
      }
    )
  );

  void vscode.commands.executeCommand('workbench.action.focusAuxiliaryBar');
  void vscode.commands.executeCommand('workbench.view.extension.oracledock-sidebar');
  void vscode.commands.executeCommand('oracledock.sidebarView');

  // SECURITY: Add disposal to subscriptions for VS Code managed cleanup
  context.subscriptions.push({
    dispose: () => {
      if (providerInstance) {
        providerInstance.dispose();
        providerInstance = null;
      }
    }
  });
}

/**
 * Extension deactivation.
 * 
 * SECURITY HARDENING:
 * - Kills all running PTYs to prevent orphan processes
 * - Clears provider reference
 * 
 * This is critical for:
 * - VS Code reload: Prevents orphan PTYs
 * - Extension host restart: Cleans up resources
 * - Extension disable: Ensures clean shutdown
 */
export function deactivate(): void {
  if (providerInstance) {
    providerInstance.dispose();
    providerInstance = null;
  }
}
