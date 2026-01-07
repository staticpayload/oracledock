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
import * as pty from 'node-pty';

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

/** Valid IPC message types from Webview - reject all others */
const VALID_MESSAGE_TYPES = new Set([
  'spawnSession', 'spawnSessionWithArgs', 'writeInput',
  'resizeSession', 'killSession', 'focusSession',
  'checkCommand', 'requestPersistedState',
  'persistProfiles', 'persistSessions', 'setActiveSession'
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

// Persisted profile - serializable agent profile
interface PersistedProfile {
  agentId: string;
  label: string;
  command: string;
  defaultArgs: string[];
  allowExtraArgs: boolean;
}

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
  profiles: PersistedProfile[];
  sessions: PersistedSession[];
  activeSessionId: string | null;
}

// Message types for Webview -> Extension communication
// spawnSessionWithArgs: New protocol for agent profiles with explicit args array
// checkCommand: CLI discovery - check if command is installed
// Persistence: requestPersistedState, persistProfiles, persistSessions, setActiveSession
interface WebviewMessage {
  type: 'spawnSession' | 'spawnSessionWithArgs' | 'writeInput' | 'resizeSession' | 'killSession' | 'focusSession' | 'checkCommand' | 'requestPersistedState' | 'persistProfiles' | 'persistSessions' | 'setActiveSession';
  command?: string;       // For spawn/checkCommand: the CLI command/executable
  args?: string[];        // For 'spawnSessionWithArgs': arguments array
  sessionId?: string;     // For session-specific operations
  data?: string;          // For 'writeInput': keyboard data from xterm
  cols?: number;          // For 'resizeSession': terminal columns
  rows?: number;          // For 'resizeSession': terminal rows
  profiles?: PersistedProfile[];   // For 'persistProfiles': profiles to save
  sessions?: PersistedSession[];   // For 'persistSessions': sessions to save
}

// Message types for Extension -> Webview communication
// commandStatus: CLI discovery response - reports installed state and resolved path
// restoreState: Persistence - sends stored state to Webview on init
interface ExtensionMessage {
  type: 'sessionStarted' | 'sessionOutput' | 'sessionExited' | 'sessionKilled' | 'error' | 'ready' | 'commandStatus' | 'restoreState';
  sessionId?: string;     // Session identifier
  command?: string;       // For 'sessionStarted'/'commandStatus': the command
  args?: string[];        // For 'sessionStarted': the arguments passed
  data?: string;          // For 'sessionOutput': PTY output chunk
  code?: number;          // For 'sessionExited': process exit code
  message?: string;       // For 'error': error description
  installed?: boolean;    // For 'commandStatus': whether command is installed
  resolvedPath?: string;  // For 'commandStatus': full path to executable (null if not installed)
  // Persistence fields for 'restoreState'
  profiles?: PersistedProfile[];
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

  // Storage key for globalState persistence
  private static readonly STORAGE_KEY = 'oracledock.persistedState';

  private _view?: vscode.WebviewView;

  // Session registry - maps sessionId to Session object
  // Maintains all active sessions with isolated lifecycles
  private _sessions: Map<string, Session> = new Map();

  // Counter for generating unique session IDs
  private _sessionCounter = 0;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _context: vscode.ExtensionContext
  ) { }

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
        // Legacy: parse command string into executable + args
        if (message.command && typeof message.command === 'string') {
          const parts = message.command.trim().split(/\s+/);
          this._spawnSessionWithArgs(parts[0], parts.slice(1));
        }
        break;

      case 'spawnSessionWithArgs':
        // New: explicit command + args array from agent profiles
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

      case 'checkCommand':
        // CLI Discovery: Check if command is installed via PATH resolution
        if (message.command) {
          this._checkCommandInstalled(message.command);
        }
        break;

      case 'requestPersistedState':
        // Persistence: Load and send stored state to Webview
        this._sendPersistedState();
        break;

      case 'persistProfiles':
        // Persistence: Save profiles to globalState
        if (message.profiles) {
          this._persistProfiles(message.profiles);
        }
        break;

      case 'persistSessions':
        // Persistence: Save sessions to globalState
        if (message.sessions) {
          this._persistSessions(message.sessions);
        }
        break;

      case 'setActiveSession':
        // Persistence: Save active session ID to globalState
        this._persistActiveSession(message.sessionId || null);
        break;
    }
  }

  /**
   * Check if a command is installed and resolve its path.
   * Uses 'which' on macOS to resolve command location via PATH.
   * 
   * SECURITY HARDENING:
   * - Validates command against alphanumeric whitelist
   * - Uses execFileSync (no shell) to prevent injection
   * 
   * Discovery rules:
   * - Resolve commands using PATH only
   * - No scanning of dot folders
   * - No inference from config presence
   * - Installed = executable is resolvable and executable
   */
  private _checkCommandInstalled(command: string): void {
    // SECURITY: Validate command before execution
    if (!command || typeof command !== 'string' || !COMMAND_REGEX.test(command)) {
      this._postMessage({
        type: 'commandStatus',
        command: command || '',
        installed: false,
        resolvedPath: undefined
      });
      return;
    }

    // SECURITY: Use execFileSync to avoid shell injection
    const { execFileSync } = require('child_process');

    try {
      // execFileSync does NOT use a shell - safe from injection
      const resolvedPath = execFileSync('which', [command], {
        encoding: 'utf8',
        timeout: 5000  // 5 second timeout to avoid hangs
      }).trim();

      // Command found - report as installed
      this._postMessage({
        type: 'commandStatus',
        command,
        installed: true,
        resolvedPath
      });
    } catch {
      // Command not found - report as not installed
      this._postMessage({
        type: 'commandStatus',
        command,
        installed: false,
        resolvedPath: undefined
      });
    }
  }

  // ========== Persistence Methods ==========

  /**
   * Load persisted state from globalState and send to Webview.
   * Called when Webview requests state on init.
   */
  private _sendPersistedState(): void {
    const state = this._context.globalState.get<PersistedState>(
      OracleDockViewProvider.STORAGE_KEY
    );

    // Send stored state or empty defaults
    this._postMessage({
      type: 'restoreState',
      profiles: state?.profiles || [],
      sessions: state?.sessions || [],
      activeSessionId: state?.activeSessionId || null
    });
  }

  /**
   * Persist profiles to globalState.
   */
  private _persistProfiles(profiles: PersistedProfile[]): void {
    const state = this._context.globalState.get<PersistedState>(
      OracleDockViewProvider.STORAGE_KEY
    ) || { profiles: [], sessions: [], activeSessionId: null };

    state.profiles = profiles;
    this._context.globalState.update(OracleDockViewProvider.STORAGE_KEY, state);
  }

  /**
   * Persist sessions to globalState.
   * Sessions are stored with output snapshots (trimmed to max lines).
   */
  private _persistSessions(sessions: PersistedSession[]): void {
    const state = this._context.globalState.get<PersistedState>(
      OracleDockViewProvider.STORAGE_KEY
    ) || { profiles: [], sessions: [], activeSessionId: null };

    // Ensure output snapshots don't exceed max size
    const trimmedSessions = sessions.map(s => ({
      ...s,
      outputSnapshot: s.outputSnapshot.slice(-OUTPUT_SNAPSHOT_MAX_LINES)
    }));

    state.sessions = trimmedSessions;
    this._context.globalState.update(OracleDockViewProvider.STORAGE_KEY, state);
  }

  /**
   * Persist active session ID to globalState.
   */
  private _persistActiveSession(sessionId: string | null): void {
    const state = this._context.globalState.get<PersistedState>(
      OracleDockViewProvider.STORAGE_KEY
    ) || { profiles: [], sessions: [], activeSessionId: null };

    state.activeSessionId = sessionId;
    this._context.globalState.update(OracleDockViewProvider.STORAGE_KEY, state);
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
    const state = this._context.globalState.get<PersistedState>(
      OracleDockViewProvider.STORAGE_KEY
    ) || { profiles: [], sessions: [], activeSessionId: null };

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

    this._context.globalState.update(OracleDockViewProvider.STORAGE_KEY, state);
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
   * - Uses execFileSync for 'which' (no shell)
   * - Tracks PTY listeners for cleanup
   * - Bounds output buffer size
   * 
   * Design decisions:
   * - Each session gets a unique sessionId
   * - Same command can be spawned multiple times (no reuse)
   * - Uses 'which' to verify command exists in PATH
   * - No shell wrapping: spawns command directly with args array
   * - Inherits process.env unchanged
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

    const sessionId = this._generateSessionId();

    // Verify executable exists in PATH
    // SECURITY: Using execFileSync with 'which' as first arg to avoid shell injection
    const { execFileSync } = require('child_process');
    let resolvedPath: string;
    try {
      // execFileSync does NOT use a shell - command is passed directly
      resolvedPath = execFileSync('which', [command], {
        encoding: 'utf8',
        timeout: 5000  // 5 second timeout
      }).trim();
    } catch {
      this._postMessage({
        type: 'error',
        sessionId,
        message: `Command not found: ${command}`
      });
      return;
    }

    try {
      // Spawn PTY with:
      // - Resolved executable path (from which)
      // - Args array passed directly (no shell parsing)
      // - User's HOME as working directory
      // - Unmodified environment (process.env passed directly)
      // - Default terminal size (will be resized by Webview)
      const ptyProcess = pty.spawn(resolvedPath, args, {
        name: 'xterm-256color',  // Terminal type for ANSI support
        cols: 80,
        rows: 24,
        cwd: os.homedir(),       // User HOME as cwd
        env: process.env as { [key: string]: string }  // Unmodified environment
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
      this._postMessage({
        type: 'error',
        sessionId,
        message: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`
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
   * - Left rail (60px): profiles + sessions icons
   * - Main panel: top bar (36px) + xterm surface
   * - Modal overlays for new session and profile editing
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
    const brainLogoUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'icon.png'));

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
    /* ========== SLEEK UI - Stage 6 ========== */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    :root {
      --rail-width: 60px;
      --topbar-height: 36px;
      --font-ui: 12px;
      --font-mono: 13px;
      --radius-overlay: 10px;
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
    
    /* ========== LAYOUT ========== */
    #app-container {
      display: flex;
      height: 100%;
      width: 100%;
    }
    
    /* Left Rail */
    #left-rail {
      width: var(--rail-width);
      min-width: var(--rail-width);
      height: 100%;
      background: var(--vscode-editor-background);
      border-right: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    
    .rail-section {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 8px 0;
    }
    
    .rail-section-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 6px;
      writing-mode: vertical-rl;
      text-orientation: mixed;
      transform: rotate(180deg);
    }
    
    .rail-separator {
      height: 1px;
      width: 40px;
      margin: 4px auto;
      background: var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    
    .rail-item {
      position: relative;
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 8px;
      margin: 2px 0;
      transition: background 0.15s ease;
    }
    
    .rail-item:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    
    .rail-item.active {
      background: var(--vscode-list-activeSelectionBackground, rgba(0,122,204,0.3));
    }
    
    .rail-item .accent-bar {
      position: absolute;
      left: 0;
      top: 50%;
      transform: translateY(-50%);
      width: 3px;
      height: 20px;
      background: var(--vscode-focusBorder);
      border-radius: 0 2px 2px 0;
      opacity: 0;
      transition: opacity 0.15s ease;
    }
    
    .rail-item.active .accent-bar {
      opacity: 1;
    }
    
    .rail-item .state-indicator {
      position: absolute;
      bottom: 6px;
      right: 6px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-descriptionForeground);
    }
    
    .rail-item .state-indicator.running {
      background: #4ec9b0;
    }
    
    .rail-item .state-indicator.exited {
      background: #f14c4c;
    }
    
    .rail-item .state-indicator.installed {
      background: #4ec9b0;
    }
    
    .rail-item .state-indicator.missing {
      background: #cca700;
    }
    
    .rail-item svg {
      width: 20px;
      height: 20px;
      color: var(--vscode-editor-foreground);
      opacity: 0.8;
    }
    
    .rail-item:hover svg {
      opacity: 1;
    }
    
    .rail-add-btn {
      width: 40px;
      height: 40px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      border-radius: 8px;
      margin: 2px 0;
      border: 1px dashed var(--vscode-descriptionForeground);
      opacity: 0.5;
      transition: all 0.15s ease;
    }
    
    .rail-add-btn:hover {
      opacity: 1;
      border-color: var(--vscode-focusBorder);
    }
    
    .rail-add-btn svg {
      width: 16px;
      height: 16px;
      color: var(--vscode-descriptionForeground);
    }
    
    /* Main Panel */
    #main-panel {
      flex: 1;
      display: flex;
      flex-direction: column;
      height: 100%;
      min-width: 0;
    }
    
    /* Top Bar */
    #top-bar {
      height: var(--topbar-height);
      min-height: var(--topbar-height);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 12px;
      background: var(--vscode-editor-background);
      border-bottom: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.2));
    }
    
    #active-label {
      font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: var(--font-mono);
      color: var(--vscode-editor-foreground);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      flex: 1;
      margin-right: 12px;
    }
    
    #active-label .state-badge {
      display: inline-block;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      margin-right: 8px;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
    }
    
    #active-label .state-badge.running {
      background: rgba(78, 201, 176, 0.2);
      color: #4ec9b0;
    }
    
    #active-label .state-badge.exited {
      background: rgba(241, 76, 76, 0.2);
      color: #f14c4c;
    }
    
    #top-bar-actions {
      display: flex;
      gap: 4px;
    }
    
    .topbar-btn {
      width: 28px;
      height: 28px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: transparent;
      border: none;
      border-radius: 4px;
      cursor: pointer;
      color: var(--vscode-editor-foreground);
      opacity: 0.7;
      transition: all 0.15s ease;
    }
    
    .topbar-btn:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
      opacity: 1;
    }
    
    .topbar-btn:disabled {
      opacity: 0.3;
      cursor: not-allowed;
    }
    
    .topbar-btn svg {
      width: 16px;
      height: 16px;
    }
    
    /* Terminal Surface */
    #terminal-surface {
      flex: 1;
      position: relative;
      overflow: hidden;
    }
    
    .terminal-wrapper {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    
    .terminal-wrapper.hidden {
      visibility: hidden;
      pointer-events: none;
    }
    
    /* Empty State */
    #empty-state {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      color: var(--vscode-descriptionForeground);
      gap: 12px;
    }
    
    #empty-state .brain-logo {
      width: 180px;
      height: auto;
      opacity: 0.6;
      filter: grayscale(100%);
      transition: opacity 0.3s ease, filter 0.3s ease;
    }
    
    #empty-state:hover .brain-logo {
      opacity: 0.9;
      filter: grayscale(0%);
    }
    
    #empty-state p {
      font-size: 16px;
      font-weight: 500;
      margin-top: 8px;
    }
    
    #empty-state .empty-hint {
      font-size: 12px;
      opacity: 0.6;
    }
    
    #empty-state.hidden {
      display: none;
    }
    
    /* ========== MODAL OVERLAYS ========== */
    .modal-overlay {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0, 0, 0, 0.6);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 100;
    }
    
    .modal-overlay.hidden {
      display: none;
    }
    
    .modal-content {
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: var(--radius-overlay);
      padding: 20px;
      min-width: 300px;
      max-width: 400px;
      box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
    }
    
    .modal-content h3 {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 16px;
      color: var(--vscode-editor-foreground);
    }
    
    .modal-field {
      margin-bottom: 12px;
    }
    
    .modal-field label {
      display: block;
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
      margin-bottom: 4px;
    }
    
    .modal-field input,
    .modal-field select {
      width: 100%;
      padding: 8px 10px;
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
      border-radius: 4px;
      color: var(--vscode-input-foreground);
      font-size: 12px;
      font-family: inherit;
    }
    
    .modal-field input:focus,
    .modal-field select:focus {
      outline: none;
      border-color: var(--vscode-focusBorder);
    }
    
    .modal-field input[type="text"] {
      font-family: 'SF Mono', Menlo, Monaco, monospace;
    }
    
    .modal-field .cli-status {
      display: inline-block;
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 4px;
      margin-left: 8px;
    }
    
    .modal-field .cli-status.installed {
      background: rgba(78, 201, 176, 0.2);
      color: #4ec9b0;
    }
    
    .modal-field .cli-status.missing {
      background: rgba(204, 167, 0, 0.2);
      color: #cca700;
    }
    
    .modal-field .cli-status.checking {
      color: var(--vscode-descriptionForeground);
    }
    
    .modal-field .install-hint {
      font-size: 10px;
      color: var(--vscode-descriptionForeground);
      margin-top: 4px;
      padding: 6px 8px;
      background: var(--vscode-input-background);
      border-radius: 4px;
      font-family: 'SF Mono', Menlo, Monaco, monospace;
    }
    
    .modal-field .install-hint code {
      color: #cca700;
    }
    
    .modal-checkbox {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 12px;
    }
    
    .modal-checkbox input {
      width: 16px;
      height: 16px;
    }
    
    .modal-checkbox span {
      font-size: 11px;
      color: var(--vscode-descriptionForeground);
    }
    
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      margin-top: 20px;
    }
    
    /* ASCII Art Preview */
    .ascii-preview {
      margin: 16px 0;
      padding: 12px;
      background: #0d0d0d;
      border-radius: 6px;
      overflow-x: auto;
      min-height: 120px;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    
    .ascii-preview pre {
      margin: 0;
      font-family: 'SF Mono', Menlo, Monaco, 'Courier New', monospace;
      font-size: 10px;
      line-height: 1.1;
      white-space: pre;
      text-align: center;
    }
    
    .ascii-preview.hidden {
      display: none;
    }
    
    .modal-btn {
      padding: 8px 16px;
      border: none;
      border-radius: 4px;
      font-size: 12px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    
    .modal-btn.primary {
      background: var(--vscode-button-background, #0e639c);
      color: var(--vscode-button-foreground, #fff);
    }
    
    .modal-btn.primary:hover {
      background: var(--vscode-button-hoverBackground, #1177bb);
    }
    
    .modal-btn.secondary {
      background: transparent;
      color: var(--vscode-editor-foreground);
      border: 1px solid var(--vscode-panel-border, rgba(128,128,128,0.3));
    }
    
    .modal-btn.secondary:hover {
      background: var(--vscode-list-hoverBackground, rgba(128,128,128,0.1));
    }
    
    .modal-btn.danger {
      background: rgba(241, 76, 76, 0.2);
      color: #f14c4c;
    }
    
    .modal-btn.danger:hover {
      background: rgba(241, 76, 76, 0.3);
    }
    
    /* ========== TOOLTIP ========== */
    .tooltip {
      position: fixed;
      background: var(--vscode-editorWidget-background, #252526);
      color: var(--vscode-editorWidget-foreground, #ccc);
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 11px;
      pointer-events: none;
      z-index: 200;
      border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.3));
      box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
      white-space: nowrap;
    }
    
    .tooltip.hidden {
      display: none;
    }
    
    /* ========== SCROLLBAR ========== */
    ::-webkit-scrollbar {
      width: 8px;
      height: 8px;
    }
    
    ::-webkit-scrollbar-track {
      background: transparent;
    }
    
    ::-webkit-scrollbar-thumb {
      background: var(--vscode-scrollbarSlider-background, rgba(128,128,128,0.3));
      border-radius: 4px;
    }
    
    ::-webkit-scrollbar-thumb:hover {
      background: var(--vscode-scrollbarSlider-hoverBackground, rgba(128,128,128,0.5));
    }
  </style>
</head>
<body>
  <div id="app-container">
    <!-- Left Rail -->
    <nav id="left-rail">
      <section class="rail-section" id="profiles-section">
        <div class="rail-add-btn" id="add-profile-btn" data-tooltip="Add Profile">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M8 3v10M3 8h10"/>
          </svg>
        </div>
      </section>
      <div class="rail-separator"></div>
      <section class="rail-section" id="sessions-section">
        <div class="rail-add-btn" id="new-session-btn" data-tooltip="New Session">
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="2" y="3" width="12" height="10" rx="1"/>
            <path d="M5 8l2 2-2 2"/>
            <path d="M9 10h3"/>
          </svg>
        </div>
      </section>
    </nav>
    
    <!-- Main Panel -->
    <main id="main-panel">
      <!-- Top Bar -->
      <header id="top-bar">
        <span id="active-label">No active session</span>
        <div id="top-bar-actions">
          <button class="topbar-btn" id="btn-new" title="New Session" disabled>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M8 3v10M3 8h10"/>
            </svg>
          </button>
          <button class="topbar-btn" id="btn-restart" title="Restart" disabled>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5"/>
              <path d="M8 2.5V0.5l2.5 2-2.5 2"/>
            </svg>
          </button>
          <button class="topbar-btn" id="btn-kill" title="Kill" disabled>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M4 4l8 8M12 4l-8 8"/>
            </svg>
          </button>
          <button class="topbar-btn" id="btn-clear" title="Clear" disabled>
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1"/>
              <path d="M2 6h12"/>
            </svg>
          </button>
        </div>
      </header>
      
      <!-- Terminal Surface -->
      <div id="terminal-surface">
        <div id="empty-state">
          <img src="${brainLogoUri}" alt="Oracle Dock" class="brain-logo">
          <p>Oracle Dock</p>
          <span class="empty-hint">Create a profile to get started</span>
        </div>
      </div>
      
      <!-- New Session Modal -->
      <div id="modal-new-session" class="modal-overlay hidden">
        <div class="modal-content">
          <h3>New Session</h3>
          <div id="ascii-preview" class="ascii-preview hidden">
            <pre id="ascii-art"></pre>
          </div>
          <div class="modal-field">
            <label>Profile</label>
            <select id="modal-profile-select">
              <option value="">Select a profile...</option>
            </select>
          </div>
          <div class="modal-field" id="modal-extra-args-field">
            <label>Extra Arguments (optional)</label>
            <input type="text" id="modal-extra-args" placeholder="--flag value">
          </div>
          <div class="modal-actions">
            <button class="modal-btn secondary" id="modal-new-cancel">Cancel</button>
            <button class="modal-btn primary" id="modal-new-run" disabled>Run</button>
          </div>
        </div>
      </div>
      
      <!-- Profile Editor Modal -->
      <div id="modal-profile-editor" class="modal-overlay hidden">
        <div class="modal-content">
          <h3 id="modal-profile-title">New Profile</h3>
          <div class="modal-field">
            <label>Label</label>
            <input type="text" id="modal-editor-label" placeholder="e.g., Claude Agent">
          </div>
          <div class="modal-field">
            <label>Command <span id="modal-cli-status" class="cli-status"></span></label>
            <input type="text" id="modal-editor-command" placeholder="e.g., claude">
            <div id="modal-install-hint" class="install-hint" style="display:none;"></div>
          </div>
          <div class="modal-field">
            <label>Default Arguments</label>
            <input type="text" id="modal-editor-args" placeholder="e.g., --dangerously-skip-permissions">
          </div>
          <div class="modal-checkbox">
            <input type="checkbox" id="modal-editor-allow-extra" checked>
            <span>Allow extra arguments on spawn</span>
          </div>
          <div class="modal-actions">
            <button class="modal-btn danger" id="modal-editor-delete" style="display:none;">Delete</button>
            <div style="flex:1;"></div>
            <button class="modal-btn secondary" id="modal-editor-cancel">Cancel</button>
            <button class="modal-btn primary" id="modal-editor-save">Save</button>
          </div>
        </div>
      </div>
    </main>
  </div>
  
  <!-- Tooltip element -->
  <div id="tooltip" class="tooltip hidden"></div>

  <!-- Bundled xterm.js -->
  <script src="${xtermJsUri}"></script>
  <script src="${xtermFitUri}"></script>

  <script nonce="${nonce}">
    (function() {
      // VS Code API for postMessage communication
      const vscode = acquireVsCodeApi();

      // ========== SECURITY LIMITS (Client-side) ==========
      // These limits mirror server-side limits for defense in depth
      
      /** Maximum lines to keep in client output buffer */
      const MAX_CLIENT_BUFFER_LINES = 5000;
      
      /** Valid message types from extension - ignore unknown types */
      const VALID_EXTENSION_MESSAGES = new Set([
        'sessionStarted', 'sessionOutput', 'sessionExited', 'sessionKilled',
        'error', 'ready', 'commandStatus', 'restoreState'
      ]);

      // ========== DOM Elements ==========
      
      // Left Rail
      const leftRail = document.getElementById('left-rail');
      const profilesSection = document.getElementById('profiles-section');
      const sessionsSection = document.getElementById('sessions-section');
      const addProfileBtn = document.getElementById('add-profile-btn');
      const newSessionBtn = document.getElementById('new-session-btn');
      
      // Top Bar
      const activeLabel = document.getElementById('active-label');
      const btnNew = document.getElementById('btn-new');
      const btnRestart = document.getElementById('btn-restart');
      const btnKill = document.getElementById('btn-kill');
      const btnClear = document.getElementById('btn-clear');
      
      // Terminal Surface
      const terminalSurface = document.getElementById('terminal-surface');
      const emptyState = document.getElementById('empty-state');
      
      // Tooltip
      const tooltip = document.getElementById('tooltip');
      
      // New Session Modal
      const modalNewSession = document.getElementById('modal-new-session');
      const modalProfileSelect = document.getElementById('modal-profile-select');
      const modalExtraArgs = document.getElementById('modal-extra-args');
      const modalExtraArgsField = document.getElementById('modal-extra-args-field');
      const modalNewCancel = document.getElementById('modal-new-cancel');
      const modalNewRun = document.getElementById('modal-new-run');
      const asciiPreview = document.getElementById('ascii-preview');
      const asciiArt = document.getElementById('ascii-art');
      
      // Profile Editor Modal
      const modalProfileEditor = document.getElementById('modal-profile-editor');
      const modalProfileTitle = document.getElementById('modal-profile-title');
      const modalEditorLabel = document.getElementById('modal-editor-label');
      const modalEditorCommand = document.getElementById('modal-editor-command');
      const modalEditorArgs = document.getElementById('modal-editor-args');
      const modalEditorAllowExtra = document.getElementById('modal-editor-allow-extra');
      const modalCliStatus = document.getElementById('modal-cli-status');
      const modalInstallHint = document.getElementById('modal-install-hint');
      const modalEditorDelete = document.getElementById('modal-editor-delete');
      const modalEditorCancel = document.getElementById('modal-editor-cancel');
      const modalEditorSave = document.getElementById('modal-editor-save');

      // ========== CLI Discovery ==========

      const INSTALL_REGISTRY = {
        'claude': 'npm install -g @anthropic-ai/claude-code',
        'codex': 'npm install -g @openai/codex',
        'aider': 'pip install aider-chat',
        'gh': 'brew install gh',
        'node': 'brew install node',
        'python': 'brew install python',
        'python3': 'brew install python',
        'npm': 'brew install node',
        'npx': 'brew install node',
        'pip': 'brew install python',
        'pip3': 'brew install python',
        'git': 'brew install git',
        'docker': 'brew install --cask docker',
        'kubectl': 'brew install kubectl',
        'aws': 'brew install awscli',
        'gcloud': 'brew install --cask google-cloud-sdk',
        'terraform': 'brew install terraform',
        'cargo': 'brew install rust',
        'rustc': 'brew install rust',
        'go': 'brew install go',
        'java': 'brew install openjdk',
        'mvn': 'brew install maven',
        'gradle': 'brew install gradle'
      };

      const cliStatusCache = new Map();
      const pendingChecks = new Set();

      // ========== ASCII Art Registry ==========
      
      // ANSI color codes for terminal rendering
      const ANSI = {
        RESET: '\x1b[0m',
        BLUE: '\x1b[38;5;33m',        // gemini
        WHITE: '\x1b[38;5;255m',      // codex
        ORANGE: '\x1b[38;5;208m',     // claude
        PURPLE: '\x1b[38;5;141m',     // kiro
        YELLOW: '\x1b[38;5;226m',     // droid
        NEON_GREEN: '\x1b[38;5;46m'   // kilo
      };

      const ASCII_REGISTRY = {
        'claude': {
          color: ANSI.ORANGE,
          art: [
            '   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗',
            '  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝',
            '  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ',
            '  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ',
            '  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗',
            '   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝'
          ]
        },
        'gemini': {
          color: ANSI.BLUE,
          art: [
            '   ██████╗ ███████╗███╗   ███╗██╗███╗   ██╗██╗',
            '  ██╔════╝ ██╔════╝████╗ ████║██║████╗  ██║██║',
            '  ██║  ███╗█████╗  ██╔████╔██║██║██╔██╗ ██║██║',
            '  ██║   ██║██╔══╝  ██║╚██╔╝██║██║██║╚██╗██║██║',
            '  ╚██████╔╝███████╗██║ ╚═╝ ██║██║██║ ╚████║██║',
            '   ╚═════╝ ╚══════╝╚═╝     ╚═╝╚═╝╚═╝  ╚═══╝╚═╝'
          ]
        },
        'codex': {
          color: ANSI.WHITE,
          art: [
            '   ██████╗ ██████╗ ██████╗ ███████╗██╗  ██╗',
            '  ██╔════╝██╔═══██╗██╔══██╗██╔════╝╚██╗██╔╝',
            '  ██║     ██║   ██║██║  ██║█████╗   ╚███╔╝ ',
            '  ██║     ██║   ██║██║  ██║██╔══╝   ██╔██╗ ',
            '  ╚██████╗╚██████╔╝██████╔╝███████╗██╔╝ ██╗',
            '   ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝╚═╝  ╚═╝'
          ]
        },
        'kiro': {
          color: ANSI.PURPLE,
          art: [
            '  ██╗  ██╗██╗██████╗  ██████╗ ',
            '  ██║ ██╔╝██║██╔══██╗██╔═══██╗',
            '  █████╔╝ ██║██████╔╝██║   ██║',
            '  ██╔═██╗ ██║██╔══██╗██║   ██║',
            '  ██║  ██╗██║██║  ██║╚██████╔╝',
            '  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ '
          ]
        },
        'kiro-cli': {
          color: ANSI.PURPLE,
          art: [
            '  ██╗  ██╗██╗██████╗  ██████╗ ',
            '  ██║ ██╔╝██║██╔══██╗██╔═══██╗',
            '  █████╔╝ ██║██████╔╝██║   ██║',
            '  ██╔═██╗ ██║██╔══██╗██║   ██║',
            '  ██║  ██╗██║██║  ██║╚██████╔╝',
            '  ╚═╝  ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ '
          ]
        },
        'droid': {
          color: ANSI.YELLOW,
          art: [
            '  ██████╗ ██████╗  ██████╗ ██╗██████╗ ',
            '  ██╔══██╗██╔══██╗██╔═══██╗██║██╔══██╗',
            '  ██║  ██║██████╔╝██║   ██║██║██║  ██║',
            '  ██║  ██║██╔══██╗██║   ██║██║██║  ██║',
            '  ██████╔╝██║  ██║╚██████╔╝██║██████╔╝',
            '  ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚═╝╚═════╝ '
          ]
        },
        'kilo': {
          color: ANSI.NEON_GREEN,
          art: [
            '  ██╗  ██╗██╗██╗      ██████╗ ',
            '  ██║ ██╔╝██║██║     ██╔═══██╗',
            '  █████╔╝ ██║██║     ██║   ██║',
            '  ██╔═██╗ ██║██║     ██║   ██║',
            '  ██║  ██╗██║███████╗╚██████╔╝',
            '  ╚═╝  ╚═╝╚═╝╚══════╝ ╚═════╝ '
          ]
        },
        'kilo-code': {
          color: ANSI.NEON_GREEN,
          art: [
            '  ██╗  ██╗██╗██╗      ██████╗ ',
            '  ██║ ██╔╝██║██║     ██╔═══██╗',
            '  █████╔╝ ██║██║     ██║   ██║',
            '  ██╔═██╗ ██║██║     ██║   ██║',
            '  ██║  ██╗██║███████╗╚██████╔╝',
            '  ╚═╝  ╚═╝╚═╝╚══════╝ ╚═════╝ '
          ]
        },
        'aider': {
          color: ANSI.NEON_GREEN,
          art: [
            '   █████╗ ██╗██████╗ ███████╗██████╗ ',
            '  ██╔══██╗██║██╔══██╗██╔════╝██╔══██╗',
            '  ███████║██║██║  ██║█████╗  ██████╔╝',
            '  ██╔══██║██║██║  ██║██╔══╝  ██╔══██╗',
            '  ██║  ██║██║██████╔╝███████╗██║  ██║',
            '  ╚═╝  ╚═╝╚═╝╚═════╝ ╚══════╝╚═╝  ╚═╝'
          ]
        }
      };

      /**
       * Render ASCII art for a command into the preview element.
       * Uses ANSI escape sequences for coloring.
       */
      function renderAsciiArt(command) {
        const entry = ASCII_REGISTRY[command];
        
        if (!entry) {
          // No ASCII art available - hide preview
          asciiPreview.classList.add('hidden');
          asciiArt.textContent = '';
          return;
        }
        
        // Build colored ASCII art with ANSI codes
        const coloredArt = entry.color + entry.art.join('\n') + ANSI.RESET;
        
        // Convert ANSI codes to HTML spans for display
        const html = ansiToHtml(coloredArt);
        asciiArt.innerHTML = html;
        asciiPreview.classList.remove('hidden');
      }

      /**
       * Convert ANSI escape sequences to HTML spans.
       * Handles 256-color codes (38;5;N format).
       */
      function ansiToHtml(text) {
        // Color mapping for 256-color codes
        const colors = {
          33: '#0087ff',   // blue (gemini)
          255: '#eeeeee',  // white (codex)
          208: '#ff8700',  // orange (claude)
          141: '#af87ff',  // purple (kiro)
          226: '#ffff00',  // yellow (droid)
          46: '#00ff00'    // neon green (kilo)
        };
        
        let html = '';
        let currentColor = null;
        let i = 0;
        
        while (i < text.length) {
          if (text[i] === '\x1b' && text[i + 1] === '[') {
            // Parse ANSI escape sequence
            let j = i + 2;
            while (j < text.length && text[j] !== 'm') {
              j++;
            }
            const code = text.substring(i + 2, j);
            
            if (code === '0') {
              // Reset
              if (currentColor) {
                html += '</span>';
                currentColor = null;
              }
            } else if (code.startsWith('38;5;')) {
              // 256-color foreground
              const colorNum = parseInt(code.substring(5), 10);
              if (currentColor) {
                html += '</span>';
              }
              const hexColor = colors[colorNum] || '#888888';
              html += '<span style="color:' + hexColor + '">';
              currentColor = hexColor;
            }
            
            i = j + 1;
          } else {
            // Escape HTML special characters
            const char = text[i];
            if (char === '<') {
              html += '&lt;';
            } else if (char === '>') {
              html += '&gt;';
            } else if (char === '&') {
              html += '&amp;';
            } else {
              html += char;
            }
            i++;
          }
        }
        
        if (currentColor) {
          html += '</span>';
        }
        
        return html;
      }

      function checkCommand(command) {
        if (!command || pendingChecks.has(command)) return;
        pendingChecks.add(command);
        vscode.postMessage({ type: 'checkCommand', command });
      }

      function getInstallHint(command) {
        return INSTALL_REGISTRY[command] || null;
      }

      function updateModalCliStatus(command) {
        if (!command) {
          modalCliStatus.textContent = '';
          modalCliStatus.className = 'cli-status';
          modalInstallHint.style.display = 'none';
          return;
        }

        const cached = cliStatusCache.get(command);
        
        if (cached) {
          if (cached.installed) {
            modalCliStatus.textContent = 'installed';
            modalCliStatus.className = 'cli-status installed';
            modalInstallHint.style.display = 'none';
          } else {
            modalCliStatus.textContent = 'missing';
            modalCliStatus.className = 'cli-status missing';
            const hint = getInstallHint(command);
            if (hint) {
              modalInstallHint.innerHTML = 'Install: <code>' + hint + '</code>';
              modalInstallHint.style.display = 'block';
            } else {
              modalInstallHint.style.display = 'none';
            }
          }
        } else {
          modalCliStatus.textContent = '...';
          modalCliStatus.className = 'cli-status checking';
          modalInstallHint.style.display = 'none';
          checkCommand(command);
        }
      }

      // ========== State Management ==========

      const profiles = new Map();
      let profileCounter = 0;
      let editingProfileId = null;

      const sessions = new Map();
      let activeSessionId = null;
      let stateRestored = false;

      // ========== Persistence ==========

      function persistProfiles() {
        const profilesArray = Array.from(profiles.values()).map(p => ({
          agentId: p.agentId,
          label: p.label,
          command: p.command,
          defaultArgs: p.defaultArgs,
          allowExtraArgs: p.allowExtraArgs
        }));
        vscode.postMessage({ type: 'persistProfiles', profiles: profilesArray });
      }

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

      // ========== Tooltip ==========

      function showTooltip(text, x, y) {
        tooltip.textContent = text;
        tooltip.style.left = (x + 8) + 'px';
        tooltip.style.top = y + 'px';
        tooltip.classList.remove('hidden');
      }

      function hideTooltip() {
        tooltip.classList.add('hidden');
      }

      // Setup tooltip for elements with data-tooltip
      document.addEventListener('mouseover', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
          const rect = target.getBoundingClientRect();
          showTooltip(target.dataset.tooltip, rect.right, rect.top);
        }
      });

      document.addEventListener('mouseout', (e) => {
        const target = e.target.closest('[data-tooltip]');
        if (target) {
          hideTooltip();
        }
      });

      // ========== Profile Management ==========

      function generateProfileId() {
        return 'profile-' + (++profileCounter) + '-' + Date.now();
      }

      function showProfileEditorModal(profile = null) {
        editingProfileId = profile ? profile.agentId : null;
        
        modalProfileTitle.textContent = profile ? 'Edit Profile' : 'New Profile';
        modalEditorLabel.value = profile ? profile.label : '';
        modalEditorCommand.value = profile ? profile.command : '';
        modalEditorArgs.value = profile ? profile.defaultArgs.join(' ') : '';
        modalEditorAllowExtra.checked = profile ? profile.allowExtraArgs : true;
        
        modalEditorDelete.style.display = profile ? 'block' : 'none';
        
        updateModalCliStatus(profile ? profile.command : '');
        
        modalProfileEditor.classList.remove('hidden');
        modalEditorLabel.focus();
      }

      function hideProfileEditorModal() {
        // SECURITY: Clear pending debounce timer to prevent stale callbacks
        if (typeof commandCheckTimeout !== 'undefined') {
          clearTimeout(commandCheckTimeout);
        }
        modalProfileEditor.classList.add('hidden');
        editingProfileId = null;
        modalCliStatus.textContent = '';
        modalCliStatus.className = 'cli-status';
        modalInstallHint.style.display = 'none';
      }

      function saveProfile() {
        const label = modalEditorLabel.value.trim();
        const command = modalEditorCommand.value.trim();
        const argsStr = modalEditorArgs.value.trim();
        const allowExtraArgs = modalEditorAllowExtra.checked;
        
        if (!label || !command) {
          return;
        }
        
        const defaultArgs = argsStr ? argsStr.split(/\\s+/) : [];
        const agentId = editingProfileId || generateProfileId();
        
        const profile = {
          agentId,
          label,
          command,
          defaultArgs,
          allowExtraArgs
        };
        
        profiles.set(agentId, profile);
        hideProfileEditorModal();
        renderRail();
        updateModalProfileSelect();
        persistProfiles();
      }

      function deleteProfile(agentId) {
        profiles.delete(agentId);
        hideProfileEditorModal();
        renderRail();
        updateModalProfileSelect();
        persistProfiles();
      }

      // ========== New Session Modal ==========

      function showNewSessionModal() {
        updateModalProfileSelect();
        modalExtraArgs.value = '';
        modalNewRun.disabled = true;
        // Reset ASCII preview
        asciiPreview.classList.add('hidden');
        asciiArt.textContent = '';
        modalNewSession.classList.remove('hidden');
        modalProfileSelect.focus();
      }

      function hideNewSessionModal() {
        modalNewSession.classList.add('hidden');
      }

      function updateModalProfileSelect() {
        modalProfileSelect.innerHTML = '<option value="">Select a profile...</option>';
        
        for (const [agentId, profile] of profiles) {
          const option = document.createElement('option');
          option.value = agentId;
          option.textContent = profile.label;
          modalProfileSelect.appendChild(option);
        }
      }

      function spawnFromModal() {
        const agentId = modalProfileSelect.value;
        if (!agentId || !profiles.has(agentId)) return;
        
        const profile = profiles.get(agentId);
        const extraArgsStr = modalExtraArgs.value.trim();
        const extraArgs = extraArgsStr ? extraArgsStr.split(/\\s+/) : [];
        const finalArgs = [...profile.defaultArgs, ...extraArgs];
        
        vscode.postMessage({
          type: 'spawnSessionWithArgs',
          command: profile.command,
          args: finalArgs
        });
        
        hideNewSessionModal();
      }

      // ========== Left Rail Rendering ==========

      function renderRail() {
        // Clear profile items (keep add button)
        const profileItems = profilesSection.querySelectorAll('.rail-item');
        profileItems.forEach(item => item.remove());
        
        // Add profile items before the add button
        for (const [agentId, profile] of profiles) {
          const item = document.createElement('div');
          item.className = 'rail-item';
          item.dataset.profileId = agentId;
          item.dataset.tooltip = profile.label;
          
          // Profile icon (person silhouette)
          item.innerHTML = \`
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="8" cy="5" r="2.5"/>
              <path d="M3 14c0-2.5 2-4.5 5-4.5s5 2 5 4.5"/>
            </svg>
            <span class="accent-bar"></span>
          \`;
          
          // State indicator for CLI status
          const cached = cliStatusCache.get(profile.command);
          const indicator = document.createElement('span');
          indicator.className = 'state-indicator';
          if (cached) {
            indicator.classList.add(cached.installed ? 'installed' : 'missing');
          }
          item.appendChild(indicator);
          
          // Check CLI if not cached
          if (!cached) {
            checkCommand(profile.command);
          }
          
          // Click to edit
          item.addEventListener('click', () => {
            showProfileEditorModal(profile);
          });
          
          profilesSection.insertBefore(item, addProfileBtn);
        }
        
        // Clear session items (keep add button)
        const sessionItems = sessionsSection.querySelectorAll('.rail-item');
        sessionItems.forEach(item => item.remove());
        
        // Add session items before the add button
        for (const [sessionId, session] of sessions) {
          const item = document.createElement('div');
          item.className = 'rail-item';
          if (sessionId === activeSessionId) item.classList.add('active');
          item.dataset.sessionId = sessionId;
          
          const fullCmd = session.args && session.args.length > 0
            ? session.command + ' ' + session.args.join(' ')
            : session.command;
          item.dataset.tooltip = fullCmd;
          
          // Terminal icon
          item.innerHTML = \`
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
              <rect x="2" y="3" width="12" height="10" rx="1"/>
              <path d="M5 7l2 1.5-2 1.5"/>
              <path d="M9 10h3"/>
            </svg>
            <span class="accent-bar"></span>
          \`;
          
          // State indicator
          const indicator = document.createElement('span');
          indicator.className = 'state-indicator ' + session.state;
          item.appendChild(indicator);
          
          // Click to switch
          item.addEventListener('click', () => {
            switchToSession(sessionId);
          });
          
          sessionsSection.insertBefore(item, newSessionBtn);
        }
      }

      // ========== Top Bar ==========

      function updateTopBar() {
        if (!activeSessionId || !sessions.has(activeSessionId)) {
          activeLabel.innerHTML = 'No active session';
          btnNew.disabled = profiles.size === 0;
          btnRestart.disabled = true;
          btnKill.disabled = true;
          btnClear.disabled = true;
          return;
        }
        
        const session = sessions.get(activeSessionId);
        const fullCmd = session.args && session.args.length > 0
          ? session.command + ' ' + session.args.join(' ')
          : session.command;
        
        const stateBadge = '<span class="state-badge ' + session.state + '">' + session.state + '</span>';
        activeLabel.innerHTML = stateBadge + fullCmd;
        
        btnNew.disabled = profiles.size === 0;
        btnRestart.disabled = session.state !== 'exited';
        btnKill.disabled = session.state !== 'running';
        btnClear.disabled = !session.terminal;
      }

      // ========== Terminal Management ==========

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

      function switchToSession(sessionId) {
        if (activeSessionId === sessionId) return;
        
        // Hide current terminal (detach pattern - just hide, don't destroy)
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
          
          // Batch DOM updates with requestAnimationFrame
          requestAnimationFrame(() => {
            session.fitAddon.fit();
            sendResize(sessionId, session.terminal);
            session.terminal.focus();
          });
        }

        renderRail();
        updateTopBar();
        emptyState.classList.add('hidden');
        
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

      function restartSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session || session.state !== 'exited') return;
        
        removeSession(sessionId);
        
        vscode.postMessage({
          type: 'spawnSessionWithArgs',
          command: session.command,
          args: session.args || []
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
        
        if (activeSessionId === sessionId) {
          activeSessionId = null;
          const remaining = Array.from(sessions.keys());
          if (remaining.length > 0) {
            switchToSession(remaining[0]);
          } else {
            emptyState.classList.remove('hidden');
            updateTopBar();
          }
        }
        
        renderRail();
        persistSessions();
      }

      function clearTerminal() {
        if (activeSessionId && sessions.has(activeSessionId)) {
          const session = sessions.get(activeSessionId);
          if (session.terminal) {
            session.terminal.clear();
          }
        }
      }

      // Handle resize
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

      // ========== Event Listeners ==========

      // Add profile button
      addProfileBtn.addEventListener('click', () => showProfileEditorModal(null));
      
      // New session button in rail
      newSessionBtn.addEventListener('click', () => {
        if (profiles.size > 0) {
          showNewSessionModal();
        } else {
          showProfileEditorModal(null);
        }
      });
      
      // Top bar buttons
      btnNew.addEventListener('click', () => showNewSessionModal());
      btnRestart.addEventListener('click', () => {
        if (activeSessionId) restartSession(activeSessionId);
      });
      btnKill.addEventListener('click', () => {
        if (activeSessionId) killSession(activeSessionId);
      });
      btnClear.addEventListener('click', clearTerminal);
      
      // Profile editor modal
      modalEditorSave.addEventListener('click', saveProfile);
      modalEditorCancel.addEventListener('click', hideProfileEditorModal);
      modalEditorDelete.addEventListener('click', () => {
        if (editingProfileId) deleteProfile(editingProfileId);
      });
      
      // CLI check on command input (debounced)
      let commandCheckTimeout = null;
      modalEditorCommand.addEventListener('input', () => {
        clearTimeout(commandCheckTimeout);
        commandCheckTimeout = setTimeout(() => {
          updateModalCliStatus(modalEditorCommand.value.trim());
        }, 300);
      });
      
      // New session modal
      modalNewCancel.addEventListener('click', hideNewSessionModal);
      modalNewRun.addEventListener('click', spawnFromModal);
      modalProfileSelect.addEventListener('change', () => {
        const agentId = modalProfileSelect.value;
        modalNewRun.disabled = !agentId;
        
        if (agentId && profiles.has(agentId)) {
          const profile = profiles.get(agentId);
          modalExtraArgsField.style.display = profile.allowExtraArgs ? 'block' : 'none';
          
          // Render ASCII art for the selected CLI
          renderAsciiArt(profile.command);
        } else {
          // Hide ASCII art when no profile selected
          asciiPreview.classList.add('hidden');
          asciiArt.textContent = '';
        }
      });
      
      // Enter key in extra args
      modalExtraArgs.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          spawnFromModal();
        }
      });
      
      // Close modals on backdrop click
      modalNewSession.addEventListener('click', (e) => {
        if (e.target === modalNewSession) hideNewSessionModal();
      });
      modalProfileEditor.addEventListener('click', (e) => {
        if (e.target === modalProfileEditor) hideProfileEditorModal();
      });
      
      // Escape key to close modals
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          if (!modalNewSession.classList.contains('hidden')) {
            hideNewSessionModal();
          }
          if (!modalProfileEditor.classList.contains('hidden')) {
            hideProfileEditorModal();
          }
        }
      });

      // ========== Message Handling ==========

      window.addEventListener('message', (event) => {
        const message = event.data;

        // SECURITY: Validate message object
        if (!message || typeof message !== 'object') {
          console.warn('[OracleDock Webview] Ignored invalid message');
          return;
        }

        // SECURITY: Reject unknown message types
        if (typeof message.type !== 'string' || !VALID_EXTENSION_MESSAGES.has(message.type)) {
          // Silently ignore unknown types - may be from other extensions
          return;
        }

        switch (message.type) {
          case 'sessionStarted': {
            const { sessionId, command, args } = message;
            
            // SECURITY: Validate required fields
            if (typeof sessionId !== 'string' || typeof command !== 'string') {
              console.warn('[OracleDock Webview] Invalid sessionStarted message');
              break;
            }

            // SECURITY: Guard against duplicate session IDs
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
            
            switchToSession(sessionId);
            persistSessions();
            break;
          }

          case 'sessionOutput': {
            const { sessionId, data } = message;
            
            // SECURITY: Validate fields
            if (typeof sessionId !== 'string' || typeof data !== 'string') break;
            
            const session = sessions.get(sessionId);
            if (session && data) {
              // SECURITY: Enforce client-side buffer limit
              if (session.outputBuffer.length >= MAX_CLIENT_BUFFER_LINES) {
                // Remove oldest 10% of entries
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
              renderRail();
              updateTopBar();
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
            console.error('Oracle Dock Error:', message.message);
            break;
          }

          case 'ready': {
            requestPersistedState();
            break;
          }

          case 'commandStatus': {
            const { command, installed, resolvedPath } = message;
            
            pendingChecks.delete(command);
            cliStatusCache.set(command, { installed, resolvedPath });
            
            if (modalEditorCommand.value.trim() === command) {
              updateModalCliStatus(command);
            }
            
            renderRail();
            break;
          }

          case 'restoreState': {
            const { profiles: restoredProfiles, sessions: restoredSessions, activeSessionId: restoredActiveId } = message;
            
            // Restore profiles
            profiles.clear();
            if (restoredProfiles && restoredProfiles.length > 0) {
              for (const p of restoredProfiles) {
                profiles.set(p.agentId, {
                  agentId: p.agentId,
                  label: p.label,
                  command: p.command,
                  defaultArgs: p.defaultArgs || [],
                  allowExtraArgs: p.allowExtraArgs !== false
                });
                const match = p.agentId.match(/profile-(\\d+)-/);
                if (match) {
                  profileCounter = Math.max(profileCounter, parseInt(match[1], 10));
                }
              }
            }
            
            // Restore sessions as exited with read-only terminals
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
            
            // Render UI
            renderRail();
            updateTopBar();
            updateModalProfileSelect();
            
            // Restore active session if valid
            if (restoredActiveId && sessions.has(restoredActiveId)) {
              switchToSession(restoredActiveId);
            } else if (sessions.size > 0) {
              switchToSession(Array.from(sessions.keys())[0]);
            }
            
            // Show empty state if no sessions
            if (sessions.size === 0) {
              emptyState.classList.remove('hidden');
            }
            
            stateRestored = true;
            break;
          }
        }
      });

      // Initial render
      renderRail();
      updateTopBar();
      
      // Enable new button once profiles exist
      btnNew.disabled = profiles.size === 0;
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
export function activate(context: vscode.ExtensionContext): void {
  // Register the WebviewViewProvider for the sidebar
  // Pass context for globalState persistence
  const provider = new OracleDockViewProvider(context.extensionUri, context);

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
