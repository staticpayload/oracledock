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

// Session lifecycle states
type SessionState = 'running' | 'exited' | 'crashed';

// Session data structure - each session is fully isolated
interface Session {
  sessionId: string;
  command: string;
  args: string[];         // Arguments passed to the command
  pty: pty.IPty;
  outputBuffer: string[];  // Stores output for replay when switching sessions
  state: SessionState;
  exitCode?: number;
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
  ) {}

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
   * Protocol:
   * - spawnSession: Create new PTY session with command (legacy, parses args from string)
   * - spawnSessionWithArgs: Create new PTY session with explicit command + args array
   * - writeInput: Forward keyboard input to specific session's PTY
   * - resizeSession: Adjust specific session's PTY dimensions
   * - killSession: Terminate specific session
   * - focusSession: Request session data replay for switching
   */
  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'spawnSession':
        // Legacy: parse command string into executable + args
        if (message.command) {
          const parts = message.command.trim().split(/\s+/);
          this._spawnSessionWithArgs(parts[0], parts.slice(1));
        }
        break;

      case 'spawnSessionWithArgs':
        // New: explicit command + args array from agent profiles
        if (message.command) {
          this._spawnSessionWithArgs(message.command, message.args || []);
        }
        break;

      case 'writeInput':
        if (message.sessionId && message.data) {
          const session = this._sessions.get(message.sessionId);
          if (session && session.state === 'running') {
            // Forward raw input to PTY - xterm handles escape sequences
            session.pty.write(message.data);
          }
        }
        break;

      case 'resizeSession':
        if (message.sessionId && message.cols && message.rows) {
          const session = this._sessions.get(message.sessionId);
          if (session && session.state === 'running') {
            // Resize PTY to match xterm dimensions
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
   * Discovery rules:
   * - Resolve commands using PATH only
   * - No scanning of dot folders
   * - No inference from config presence
   * - Installed = executable is resolvable and executable
   */
  private _checkCommandInstalled(command: string): void {
    const { execSync } = require('child_process');
    
    try {
      // Use 'which' to resolve command path - macOS first
      const resolvedPath = execSync(`which ${command}`, { 
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
    const sessionId = this._generateSessionId();

    // Verify executable exists in PATH
    // Using 'which' because we're macOS-first
    const { execSync } = require('child_process');
    let resolvedPath: string;
    try {
      resolvedPath = execSync(`which ${command}`, { encoding: 'utf8' }).trim();
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
      const session: Session = {
        sessionId,
        command,
        args,
        pty: ptyProcess,
        outputBuffer: [],
        state: 'running'
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
      ptyProcess.onData((data: string) => {
        // Buffer output for session switching replay
        session.outputBuffer.push(data);
        
        // Stream to Webview
        this._postMessage({
          type: 'sessionOutput',
          sessionId,
          data
        });
      });

      // Handle PTY exit
      ptyProcess.onExit(({ exitCode }) => {
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
   */
  private _killSession(sessionId: string): void {
    const session = this._sessions.get(sessionId);
    if (session) {
      if (session.state === 'running') {
        session.pty.kill();
        session.state = 'exited';
      }
      this._sessions.delete(sessionId);
      this._postMessage({
        type: 'sessionKilled',
        sessionId
      });
    }
  }

  /**
   * Terminate all sessions.
   * Called when Webview is disposed.
   */
  private _killAllSessions(): void {
    for (const [sessionId, session] of this._sessions) {
      if (session.state === 'running') {
        session.pty.kill();
      }
    }
    this._sessions.clear();
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
    connect-src ${webview.cspSource};
  ">
  <title>Oracle Dock</title>
  <link rel="stylesheet" href="${xtermCssUri}">
  <style>
    /* Minimal functional layout - no polish */
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { 
      height: 100%; 
      width: 100%; 
      overflow: hidden;
      background: #1e1e1e;
      color: #d4d4d4;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      font-size: 12px;
    }
    
    /* Tab navigation */
    #tab-bar {
      display: flex;
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
    }
    .tab {
      padding: 6px 12px;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      font-size: 11px;
    }
    .tab:hover { background: #2a2d2e; }
    .tab.active { border-bottom-color: #007acc; color: #fff; }
    
    /* Panels */
    .panel { display: none; }
    .panel.active { display: block; }
    
    /* Control panel (profiles + spawn) */
    #control-panel {
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      max-height: 200px;
      overflow-y: auto;
    }
    
    /* Profile list */
    #profile-list {
      list-style: none;
      max-height: 100px;
      overflow-y: auto;
    }
    .profile-item {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      border-bottom: 1px solid #333;
      cursor: pointer;
    }
    .profile-item:hover { background: #2a2d2e; }
    .profile-item.selected { background: #094771; }
    .profile-label {
      flex: 1;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .profile-command {
      font-family: monospace;
      font-size: 10px;
      color: #888;
      margin-left: 8px;
    }
    .profile-btn {
      padding: 2px 6px;
      margin-left: 4px;
      background: #3c3c3c;
      border: none;
      color: #ccc;
      cursor: pointer;
      font-size: 10px;
    }
    .profile-btn:hover { background: #4c4c4c; }
    .profile-btn.delete { background: #5a1d1d; color: #f88; }
    .profile-btn.delete:hover { background: #7a2d2d; }
    
    /* CLI Status indicators */
    .cli-status {
      font-size: 9px;
      padding: 1px 4px;
      border-radius: 2px;
      margin-left: 4px;
    }
    .cli-status.installed { background: #2d5a2d; color: #8f8; }
    .cli-status.missing { background: #5a4a1d; color: #fa8; }
    .cli-status.checking { background: #3c3c3c; color: #888; }
    
    /* Install hint */
    .install-hint {
      font-size: 10px;
      color: #888;
      padding: 4px 6px;
      background: #2a2a2a;
      border-left: 2px solid #5a4a1d;
      margin: 4px 6px;
      font-family: monospace;
    }
    .install-hint code {
      color: #fa8;
      background: #333;
      padding: 1px 4px;
      border-radius: 2px;
    }
    
    /* Spawn row */
    #spawn-row {
      display: flex;
      padding: 6px;
      gap: 4px;
      border-bottom: 1px solid #3c3c3c;
      flex-wrap: wrap;
    }
    #profile-select {
      padding: 4px 8px;
      background: #3c3c3c;
      border: 1px solid #555;
      color: #fff;
      font-size: 11px;
      min-width: 120px;
    }
    #extra-args-input {
      flex: 1;
      min-width: 100px;
      padding: 4px 8px;
      background: #3c3c3c;
      border: 1px solid #555;
      color: #fff;
      font-family: monospace;
      font-size: 12px;
    }
    #extra-args-input:focus, #profile-select:focus {
      outline: 1px solid #007acc;
      border-color: #007acc;
    }
    #spawn-btn {
      padding: 4px 8px;
      background: #0e639c;
      border: none;
      color: #fff;
      cursor: pointer;
      font-size: 11px;
    }
    #spawn-btn:hover { background: #1177bb; }
    #spawn-btn:disabled { background: #555; cursor: not-allowed; }
    
    /* Profile editor */
    #profile-editor {
      padding: 6px;
      border-bottom: 1px solid #3c3c3c;
      background: #2d2d2d;
    }
    #profile-editor.hidden { display: none; }
    .editor-row {
      display: flex;
      gap: 4px;
      margin-bottom: 4px;
      align-items: center;
    }
    .editor-row label {
      width: 80px;
      font-size: 11px;
    }
    .editor-row input {
      flex: 1;
      padding: 3px 6px;
      background: #3c3c3c;
      border: 1px solid #555;
      color: #fff;
      font-family: monospace;
      font-size: 11px;
    }
    .editor-row input:focus {
      outline: 1px solid #007acc;
      border-color: #007acc;
    }
    .editor-row input[type="checkbox"] {
      flex: none;
      width: 14px;
      height: 14px;
    }
    .editor-buttons {
      display: flex;
      gap: 4px;
      margin-top: 6px;
    }
    .editor-buttons button {
      padding: 4px 10px;
      border: none;
      cursor: pointer;
      font-size: 11px;
    }
    #save-profile-btn { background: #0e639c; color: #fff; }
    #save-profile-btn:hover { background: #1177bb; }
    #cancel-profile-btn { background: #3c3c3c; color: #ccc; }
    #cancel-profile-btn:hover { background: #4c4c4c; }
    #add-profile-btn {
      padding: 4px 8px;
      margin: 6px;
      background: #2d5a2d;
      border: none;
      color: #8f8;
      cursor: pointer;
      font-size: 11px;
    }
    #add-profile-btn:hover { background: #3d6a3d; }
    
    /* Session list */
    #session-panel {
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      max-height: 120px;
      overflow-y: auto;
    }
    #session-list {
      list-style: none;
    }
    .session-item {
      display: flex;
      align-items: center;
      padding: 4px 6px;
      border-bottom: 1px solid #333;
      cursor: pointer;
    }
    .session-item:hover { background: #2a2d2e; }
    .session-item.active { background: #094771; }
    .session-item.exited { opacity: 0.6; }
    .session-command {
      flex: 1;
      font-family: monospace;
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .session-state {
      font-size: 10px;
      margin-right: 6px;
      padding: 1px 4px;
      border-radius: 2px;
    }
    .session-state.running { background: #2d5a2d; color: #8f8; }
    .session-state.exited { background: #5a2d2d; color: #f88; }
    .kill-btn {
      padding: 2px 6px;
      background: #5a1d1d;
      border: none;
      color: #f88;
      cursor: pointer;
      font-size: 10px;
    }
    .kill-btn:hover { background: #7a2d2d; }
    
    /* Terminal container */
    #terminal-container {
      height: calc(100% - 220px);
      width: 100%;
      position: relative;
    }
    .terminal-wrapper {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
    }
    .terminal-wrapper.hidden { display: none; }
    
    /* Error display */
    #error-display {
      color: #f44;
      padding: 8px;
      font-family: monospace;
      font-size: 12px;
      display: none;
    }
    
    /* Empty state */
    #empty-state {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      color: #666;
      font-size: 13px;
    }
  </style>
</head>
<body>
  <!-- Tab navigation for Profiles/Sessions views -->
  <div id="tab-bar">
    <div class="tab active" data-tab="profiles">Profiles</div>
    <div class="tab" data-tab="sessions">Sessions</div>
  </div>
  
  <!-- Profiles panel -->
  <div id="profiles-panel" class="panel active">
    <!-- Profile editor (hidden by default) -->
    <div id="profile-editor" class="hidden">
      <div class="editor-row">
        <label>Label:</label>
        <input type="text" id="editor-label" placeholder="e.g., Claude Agent">
      </div>
      <div class="editor-row">
        <label>Command:</label>
        <input type="text" id="editor-command" placeholder="e.g., claude">
        <span id="editor-cli-status" class="cli-status checking">...</span>
      </div>
      <!-- Install hint shown when CLI is missing -->
      <div id="editor-install-hint" class="install-hint" style="display:none;"></div>
      <div class="editor-row">
        <label>Default Args:</label>
        <input type="text" id="editor-args" placeholder="e.g., --dangerously-skip-permissions">
      </div>
      <div class="editor-row">
        <label>Allow Extra:</label>
        <input type="checkbox" id="editor-allow-extra" checked>
        <span style="font-size:10px;color:#888;">Allow extra args on spawn</span>
      </div>
      <div class="editor-buttons">
        <button id="save-profile-btn">Save</button>
        <button id="cancel-profile-btn">Cancel</button>
      </div>
    </div>
    
    <!-- Profile list -->
    <ul id="profile-list"></ul>
    <button id="add-profile-btn">+ Add Profile</button>
    
    <!-- Spawn row -->
    <div id="spawn-row">
      <select id="profile-select">
        <option value="">Select profile...</option>
      </select>
      <input 
        type="text" 
        id="extra-args-input" 
        placeholder="Extra args..."
        autocomplete="off"
        spellcheck="false"
      >
      <button id="spawn-btn" disabled>Run</button>
    </div>
  </div>
  
  <!-- Sessions panel -->
  <div id="sessions-panel" class="panel">
    <ul id="session-list"></ul>
  </div>
  
  <div id="error-display"></div>
  
  <!-- Terminal container: holds all xterm instances, one visible at a time -->
  <div id="terminal-container">
    <div id="empty-state">No sessions. Create a profile and run it above.</div>
  </div>

  <!-- xterm.js library -->
  <script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
  <!-- xterm-addon-fit: auto-resize terminal to container -->
  <script src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>

  <script nonce="${nonce}">
    (function() {
      // VS Code API for postMessage communication
      const vscode = acquireVsCodeApi();

      // DOM elements - Tabs
      const tabs = document.querySelectorAll('.tab');
      const profilesPanel = document.getElementById('profiles-panel');
      const sessionsPanel = document.getElementById('sessions-panel');
      
      // DOM elements - Profile management
      const profileEditor = document.getElementById('profile-editor');
      const editorLabel = document.getElementById('editor-label');
      const editorCommand = document.getElementById('editor-command');
      const editorArgs = document.getElementById('editor-args');
      const editorAllowExtra = document.getElementById('editor-allow-extra');
      const editorCliStatus = document.getElementById('editor-cli-status');
      const editorInstallHint = document.getElementById('editor-install-hint');
      const saveProfileBtn = document.getElementById('save-profile-btn');
      const cancelProfileBtn = document.getElementById('cancel-profile-btn');
      const addProfileBtn = document.getElementById('add-profile-btn');
      const profileList = document.getElementById('profile-list');
      const profileSelect = document.getElementById('profile-select');
      const extraArgsInput = document.getElementById('extra-args-input');
      const spawnBtn = document.getElementById('spawn-btn');
      
      // DOM elements - Sessions
      const sessionList = document.getElementById('session-list');
      const terminalContainer = document.getElementById('terminal-container');
      const emptyState = document.getElementById('empty-state');
      const errorDisplay = document.getElementById('error-display');

      // ========== CLI Discovery ==========

      /**
       * Install registry - static mapping of commands to install instructions.
       * macOS only. Advisory only - never auto-installs.
       */
      const INSTALL_REGISTRY = {
        'claude': 'brew install claude',
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

      /**
       * CLI status cache - stores discovered CLI states.
       * Key: command name, Value: { installed: boolean, resolvedPath: string|null }
       */
      const cliStatusCache = new Map();

      /**
       * Pending CLI checks - tracks commands being checked.
       */
      const pendingChecks = new Set();

      /**
       * Request CLI status check from extension host.
       */
      function checkCommand(command) {
        if (!command || pendingChecks.has(command)) return;
        
        pendingChecks.add(command);
        vscode.postMessage({ type: 'checkCommand', command });
      }

      /**
       * Get install hint for a command.
       */
      function getInstallHint(command) {
        return INSTALL_REGISTRY[command] || null;
      }

      /**
       * Update CLI status display in profile editor.
       */
      function updateEditorCliStatus(command) {
        if (!command) {
          editorCliStatus.textContent = '';
          editorCliStatus.className = 'cli-status';
          editorInstallHint.style.display = 'none';
          return;
        }

        const cached = cliStatusCache.get(command);
        
        if (cached) {
          if (cached.installed) {
            editorCliStatus.textContent = 'installed';
            editorCliStatus.className = 'cli-status installed';
            editorInstallHint.style.display = 'none';
          } else {
            editorCliStatus.textContent = 'missing';
            editorCliStatus.className = 'cli-status missing';
            
            // Show install hint if available
            const hint = getInstallHint(command);
            if (hint) {
              editorInstallHint.innerHTML = 'Install: <code>' + hint + '</code>';
              editorInstallHint.style.display = 'block';
            } else {
              editorInstallHint.style.display = 'none';
            }
          }
        } else {
          editorCliStatus.textContent = '...';
          editorCliStatus.className = 'cli-status checking';
          editorInstallHint.style.display = 'none';
          
          // Request check from extension
          checkCommand(command);
        }
      }

      /**
       * AgentProfile model
       * Stored in Webview state and persisted to extension globalState
       * 
       * @typedef {Object} AgentProfile
       * @property {string} agentId - Unique identifier
       * @property {string} label - Display name
       * @property {string} command - CLI executable
       * @property {string[]} defaultArgs - Default arguments
       * @property {boolean} allowExtraArgs - Whether extra args can be added on spawn
       */
      
      // Profile registry - stored in Webview state and persisted
      const profiles = new Map();
      let profileCounter = 0;
      let editingProfileId = null;  // null = creating new, string = editing existing

      /**
       * Session registry - mirrors extension host registry
       * Each session holds:
       * - sessionId: unique identifier
       * - command: the spawned command
       * - args: arguments passed
       * - terminal: xterm.js Terminal instance (null for restored sessions)
       * - fitAddon: FitAddon instance for this terminal (null for restored)
       * - wrapper: DOM element containing the terminal
       * - state: 'running' | 'exited'
       * - outputBuffer: stored output for reference
       * - restored: boolean indicating if session was restored from persistence
       */
      const sessions = new Map();
      let activeSessionId = null;
      let stateRestored = false;  // Track if state has been restored

      // ========== Persistence Functions ==========

      /**
       * Persist all profiles to extension globalState.
       */
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

      /**
       * Persist all sessions to extension globalState.
       * Only persists metadata and output snapshot, not PTY handles.
       */
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

      /**
       * Persist active session ID.
       */
      function persistActiveSession() {
        vscode.postMessage({ type: 'setActiveSession', sessionId: activeSessionId });
      }

      /**
       * Request persisted state from extension on init.
       */
      function requestPersistedState() {
        vscode.postMessage({ type: 'requestPersistedState' });
      }

      // ========== Tab Navigation ==========
      
      tabs.forEach(tab => {
        tab.addEventListener('click', () => {
          const targetTab = tab.dataset.tab;
          
          // Update tab active state
          tabs.forEach(t => t.classList.remove('active'));
          tab.classList.add('active');
          
          // Show/hide panels
          profilesPanel.classList.toggle('active', targetTab === 'profiles');
          sessionsPanel.classList.toggle('active', targetTab === 'sessions');
        });
      });

      // ========== Profile Management ==========

      /**
       * Generate unique profile ID.
       */
      function generateProfileId() {
        return 'profile-' + (++profileCounter) + '-' + Date.now();
      }

      /**
       * Show profile editor for creating or editing.
       */
      function showProfileEditor(profile = null) {
        editingProfileId = profile ? profile.agentId : null;
        
        editorLabel.value = profile ? profile.label : '';
        editorCommand.value = profile ? profile.command : '';
        editorArgs.value = profile ? profile.defaultArgs.join(' ') : '';
        editorAllowExtra.checked = profile ? profile.allowExtraArgs : true;
        
        // Check CLI status for existing command
        updateEditorCliStatus(profile ? profile.command : '');
        
        profileEditor.classList.remove('hidden');
        editorLabel.focus();
      }

      /**
       * Hide profile editor.
       */
      function hideProfileEditor() {
        profileEditor.classList.add('hidden');
        editingProfileId = null;
        
        // Clear CLI status display
        editorCliStatus.textContent = '';
        editorCliStatus.className = 'cli-status';
        editorInstallHint.style.display = 'none';
      }

      /**
       * Save profile from editor.
       */
      function saveProfile() {
        const label = editorLabel.value.trim();
        const command = editorCommand.value.trim();
        const argsStr = editorArgs.value.trim();
        const allowExtraArgs = editorAllowExtra.checked;
        
        if (!label || !command) {
          alert('Label and Command are required');
          return;
        }
        
        // Parse args string into array (split on whitespace)
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
        hideProfileEditor();
        renderProfileList();
        renderProfileSelect();
        
        // Persist profiles to globalState
        persistProfiles();
      }

      /**
       * Delete a profile.
       */
      function deleteProfile(agentId) {
        profiles.delete(agentId);
        renderProfileList();
        renderProfileSelect();
        
        // Persist profiles to globalState
        persistProfiles();
      }

      /**
       * Render the profile list UI.
       * Shows CLI status indicator for each profile.
       */
      function renderProfileList() {
        profileList.innerHTML = '';
        
        for (const [agentId, profile] of profiles) {
          const li = document.createElement('li');
          li.className = 'profile-item';
          
          // CLI status indicator
          const statusSpan = document.createElement('span');
          const cached = cliStatusCache.get(profile.command);
          if (cached) {
            statusSpan.className = 'cli-status ' + (cached.installed ? 'installed' : 'missing');
            statusSpan.textContent = cached.installed ? 'OK' : '!';
            statusSpan.title = cached.installed ? 'Installed: ' + cached.resolvedPath : 'Not installed';
          } else {
            statusSpan.className = 'cli-status checking';
            statusSpan.textContent = '?';
            statusSpan.title = 'Checking...';
            // Trigger check if not already cached
            checkCommand(profile.command);
          }
          
          // Label
          const labelSpan = document.createElement('span');
          labelSpan.className = 'profile-label';
          labelSpan.textContent = profile.label;
          
          // Command preview
          const cmdSpan = document.createElement('span');
          cmdSpan.className = 'profile-command';
          const fullCmd = [profile.command, ...profile.defaultArgs].join(' ');
          cmdSpan.textContent = fullCmd.length > 30 ? fullCmd.substring(0, 30) + '...' : fullCmd;
          
          // Edit button
          const editBtn = document.createElement('button');
          editBtn.className = 'profile-btn';
          editBtn.textContent = 'Edit';
          editBtn.onclick = (e) => {
            e.stopPropagation();
            showProfileEditor(profile);
          };
          
          // Delete button
          const deleteBtn = document.createElement('button');
          deleteBtn.className = 'profile-btn delete';
          deleteBtn.textContent = 'Del';
          deleteBtn.onclick = (e) => {
            e.stopPropagation();
            deleteProfile(agentId);
          };
          
          li.appendChild(statusSpan);
          li.appendChild(labelSpan);
          li.appendChild(cmdSpan);
          li.appendChild(editBtn);
          li.appendChild(deleteBtn);
          
          profileList.appendChild(li);
        }
      }

      /**
       * Render the profile select dropdown.
       */
      function renderProfileSelect() {
        // Clear existing options except the placeholder
        profileSelect.innerHTML = '<option value="">Select profile...</option>';
        
        for (const [agentId, profile] of profiles) {
          const option = document.createElement('option');
          option.value = agentId;
          option.textContent = profile.label;
          profileSelect.appendChild(option);
        }
        
        updateSpawnButton();
      }

      /**
       * Update spawn button enabled state.
       */
      function updateSpawnButton() {
        const selectedId = profileSelect.value;
        spawnBtn.disabled = !selectedId;
        
        // Update extra args input based on profile's allowExtraArgs
        if (selectedId && profiles.has(selectedId)) {
          const profile = profiles.get(selectedId);
          extraArgsInput.disabled = !profile.allowExtraArgs;
          extraArgsInput.placeholder = profile.allowExtraArgs ? 'Extra args...' : 'Extra args disabled';
        } else {
          extraArgsInput.disabled = true;
          extraArgsInput.placeholder = 'Select a profile first';
        }
      }

      /**
       * Spawn a session from the selected profile.
       */
      function spawnFromProfile() {
        const agentId = profileSelect.value;
        if (!agentId || !profiles.has(agentId)) return;
        
        const profile = profiles.get(agentId);
        
        // Build final args: defaultArgs + extraArgs
        const extraArgsStr = extraArgsInput.value.trim();
        const extraArgs = extraArgsStr ? extraArgsStr.split(/\\s+/) : [];
        const finalArgs = [...profile.defaultArgs, ...extraArgs];
        
        // Send spawnSessionWithArgs message
        errorDisplay.style.display = 'none';
        vscode.postMessage({
          type: 'spawnSessionWithArgs',
          command: profile.command,
          args: finalArgs
        });
        
        // Clear extra args input
        extraArgsInput.value = '';
        
        // Switch to sessions tab
        tabs.forEach(t => t.classList.remove('active'));
        document.querySelector('[data-tab="sessions"]').classList.add('active');
        profilesPanel.classList.remove('active');
        sessionsPanel.classList.add('active');
      }

      // Profile event listeners
      addProfileBtn.addEventListener('click', () => showProfileEditor(null));
      saveProfileBtn.addEventListener('click', saveProfile);
      cancelProfileBtn.addEventListener('click', hideProfileEditor);
      profileSelect.addEventListener('change', updateSpawnButton);
      spawnBtn.addEventListener('click', spawnFromProfile);
      
      // Check CLI status when command input changes (debounced)
      let commandCheckTimeout = null;
      editorCommand.addEventListener('input', () => {
        clearTimeout(commandCheckTimeout);
        commandCheckTimeout = setTimeout(() => {
          updateEditorCliStatus(editorCommand.value.trim());
        }, 300);
      });
      
      extraArgsInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          spawnFromProfile();
        }
      });

      // ========== Session Management ==========

      /**
       * Create a new xterm instance for a session.
       */
      function createTerminalForSession(sessionId) {
        const terminal = new Terminal({
          cursorBlink: true,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: 13,
          theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#aeafad'
          }
        });

        const fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);

        const wrapper = document.createElement('div');
        wrapper.className = 'terminal-wrapper hidden';
        wrapper.id = 'terminal-' + sessionId;
        terminalContainer.appendChild(wrapper);

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

      /**
       * Switch active session.
       */
      function switchToSession(sessionId) {
        if (activeSessionId === sessionId) return;
        
        if (activeSessionId && sessions.has(activeSessionId)) {
          const current = sessions.get(activeSessionId);
          current.wrapper.classList.add('hidden');
        }

        const session = sessions.get(sessionId);
        if (session) {
          session.wrapper.classList.remove('hidden');
          activeSessionId = sessionId;
          
          setTimeout(() => {
            session.fitAddon.fit();
            sendResize(sessionId, session.terminal);
            session.terminal.focus();
          }, 10);
        }

        renderSessionList();
        emptyState.style.display = 'none';
        vscode.postMessage({ type: 'focusSession', sessionId });
      }

      /**
       * Send resize event for a specific session.
       */
      function sendResize(sessionId, terminal) {
        vscode.postMessage({
          type: 'resizeSession',
          sessionId: sessionId,
          cols: terminal.cols,
          rows: terminal.rows
        });
      }

      /**
       * Render the session list UI.
       * Shows command + args for each session.
       * Exited sessions show restart button instead of kill.
       */
      function renderSessionList() {
        sessionList.innerHTML = '';
        
        for (const [sessionId, session] of sessions) {
          const li = document.createElement('li');
          li.className = 'session-item';
          if (sessionId === activeSessionId) li.classList.add('active');
          if (session.state === 'exited') li.classList.add('exited');
          
          const stateBadge = document.createElement('span');
          stateBadge.className = 'session-state ' + session.state;
          stateBadge.textContent = session.state;
          
          // Display command + args
          const cmdSpan = document.createElement('span');
          cmdSpan.className = 'session-command';
          const fullCmd = session.args && session.args.length > 0
            ? session.command + ' ' + session.args.join(' ')
            : session.command;
          cmdSpan.textContent = fullCmd;
          
          // Show restart or kill button based on state
          if (session.state === 'exited') {
            const restartBtn = document.createElement('button');
            restartBtn.className = 'profile-btn';
            restartBtn.textContent = 'Restart';
            restartBtn.onclick = (e) => {
              e.stopPropagation();
              restartSession(sessionId);
            };
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'kill-btn';
            removeBtn.textContent = 'X';
            removeBtn.onclick = (e) => {
              e.stopPropagation();
              removeExitedSession(sessionId);
            };
            
            li.appendChild(stateBadge);
            li.appendChild(cmdSpan);
            li.appendChild(restartBtn);
            li.appendChild(removeBtn);
          } else {
            const killBtn = document.createElement('button');
            killBtn.className = 'kill-btn';
            killBtn.textContent = 'Kill';
            killBtn.onclick = (e) => {
              e.stopPropagation();
              vscode.postMessage({ type: 'killSession', sessionId });
            };
            
            li.appendChild(stateBadge);
            li.appendChild(cmdSpan);
            li.appendChild(killBtn);
          }
          
          li.onclick = () => switchToSession(sessionId);
          
          sessionList.appendChild(li);
        }
      }

      /**
       * Restart an exited session - spawns fresh PTY with same command/args.
       */
      function restartSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session || session.state !== 'exited') return;
        
        // Remove old session
        removeExitedSession(sessionId);
        
        // Spawn fresh PTY with same command/args
        vscode.postMessage({
          type: 'spawnSessionWithArgs',
          command: session.command,
          args: session.args || []
        });
      }

      /**
       * Remove an exited session from the list.
       */
      function removeExitedSession(sessionId) {
        const session = sessions.get(sessionId);
        if (!session) return;
        
        // Dispose terminal if exists
        if (session.terminal) {
          session.terminal.dispose();
        }
        if (session.wrapper) {
          session.wrapper.remove();
        }
        
        sessions.delete(sessionId);
        
        // If this was active, switch to another or show empty
        if (activeSessionId === sessionId) {
          activeSessionId = null;
          const remaining = Array.from(sessions.keys());
          if (remaining.length > 0) {
            switchToSession(remaining[0]);
          } else {
            emptyState.style.display = 'flex';
          }
        }
        
        renderSessionList();
        persistSessions();
      }

      /**
       * Create a read-only terminal for restored session.
       * Displays output snapshot but doesn't accept input.
       */
      function createRestoredTerminal(sessionId, outputSnapshot) {
        const terminal = new Terminal({
          cursorBlink: false,
          fontFamily: 'Menlo, Monaco, "Courier New", monospace',
          fontSize: 13,
          disableStdin: true,  // Read-only
          theme: {
            background: '#1e1e1e',
            foreground: '#d4d4d4',
            cursor: '#aeafad'
          }
        });

        const fitAddon = new FitAddon.FitAddon();
        terminal.loadAddon(fitAddon);

        const wrapper = document.createElement('div');
        wrapper.className = 'terminal-wrapper hidden';
        wrapper.id = 'terminal-' + sessionId;
        terminalContainer.appendChild(wrapper);

        terminal.open(wrapper);
        
        // Write restored output snapshot
        if (outputSnapshot && outputSnapshot.length > 0) {
          terminal.write(outputSnapshot.join('\\n'));
          terminal.write('\\r\\n\\x1b[90m[Session restored - output is read-only]\\x1b[0m\\r\\n');
        } else {
          terminal.write('\\x1b[90m[No output snapshot available]\\x1b[0m\\r\\n');
        }

        return { terminal, fitAddon, wrapper };
      }

      // Handle resize for active terminal
      const resizeObserver = new ResizeObserver(() => {
        if (activeSessionId && sessions.has(activeSessionId)) {
          const session = sessions.get(activeSessionId);
          session.fitAddon.fit();
          sendResize(activeSessionId, session.terminal);
        }
      });
      resizeObserver.observe(terminalContainer);

      // ========== Message Handling ==========

      /**
       * Handle messages from extension host.
       */
      window.addEventListener('message', (event) => {
        const message = event.data;

        switch (message.type) {
          case 'sessionStarted': {
            const { sessionId, command, args } = message;
            
            const { terminal, fitAddon, wrapper } = createTerminalForSession(sessionId);
            
            sessions.set(sessionId, {
              sessionId,
              command,
              args: args || [],
              terminal,
              fitAddon,
              wrapper,
              state: 'running',
              outputBuffer: []
            });
            
            switchToSession(sessionId);
            break;
          }

          case 'sessionOutput': {
            const { sessionId, data } = message;
            const session = sessions.get(sessionId);
            if (session && data) {
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
              session.terminal.write('\\r\\n\\x1b[90m[Process exited with code ' + code + ']\\x1b[0m\\r\\n');
              renderSessionList();
            }
            break;
          }

          case 'sessionKilled': {
            const { sessionId } = message;
            const session = sessions.get(sessionId);
            if (session) {
              session.terminal.dispose();
              session.wrapper.remove();
              sessions.delete(sessionId);
              
              if (activeSessionId === sessionId) {
                activeSessionId = null;
                const remaining = Array.from(sessions.keys());
                if (remaining.length > 0) {
                  switchToSession(remaining[0]);
                } else {
                  emptyState.style.display = 'flex';
                }
              }
              
              renderSessionList();
            }
            break;
          }

          case 'error': {
            errorDisplay.textContent = message.message;
            errorDisplay.style.display = 'block';
            break;
          }

          case 'ready': {
            // Request persisted state on init
            requestPersistedState();
            break;
          }

          case 'commandStatus': {
            // CLI Discovery: Update cache with command status from extension
            const { command, installed, resolvedPath } = message;
            
            // Remove from pending
            pendingChecks.delete(command);
            
            // Cache the result
            cliStatusCache.set(command, { installed, resolvedPath });
            
            // Update editor if this command is currently being edited
            if (editorCommand.value.trim() === command) {
              updateEditorCliStatus(command);
            }
            
            // Re-render profile list to update status indicators
            renderProfileList();
            break;
          }

          case 'restoreState': {
            // Persistence: Restore profiles and sessions from globalState
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
                // Update profile counter to avoid ID collisions
                const match = p.agentId.match(/profile-(\\d+)-/);
                if (match) {
                  profileCounter = Math.max(profileCounter, parseInt(match[1], 10));
                }
              }
            }
            
            // Restore sessions as exited with read-only terminals
            if (restoredSessions && restoredSessions.length > 0) {
              for (const s of restoredSessions) {
                // Skip if session already exists (shouldn't happen, but safety check)
                if (sessions.has(s.sessionId)) continue;
                
                // Create read-only terminal for restored session
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
                  state: 'exited',  // Always restore as exited
                  exitCode: s.exitCode,
                  outputBuffer: s.outputSnapshot || [],
                  restored: true
                });
              }
            }
            
            // Render UI
            renderProfileList();
            renderProfileSelect();
            renderSessionList();
            
            // Restore active session if valid
            if (restoredActiveId && sessions.has(restoredActiveId)) {
              switchToSession(restoredActiveId);
            } else if (sessions.size > 0) {
              // Switch to first session if active no longer exists
              switchToSession(Array.from(sessions.keys())[0]);
            }
            
            stateRestored = true;
            break;
          }
        }
      });

      // Initial render (will be updated when restoreState arrives)
      renderProfileList();
      renderProfileSelect();
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

/**
 * Extension activation.
 * Called when the extension is first activated (e.g., sidebar opened).
 */
export function activate(context: vscode.ExtensionContext): void {
  // Register the WebviewViewProvider for the sidebar
  // Pass context for globalState persistence
  const provider = new OracleDockViewProvider(context.extensionUri, context);

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
}

/**
 * Extension deactivation.
 * Cleanup is handled by subscription disposal.
 */
export function deactivate(): void {}
