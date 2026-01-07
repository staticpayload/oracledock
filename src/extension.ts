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
  pty: pty.IPty;
  outputBuffer: string[];  // Stores output for replay when switching sessions
  state: SessionState;
  exitCode?: number;
}

// Message types for Webview -> Extension communication
interface WebviewMessage {
  type: 'spawnSession' | 'writeInput' | 'resizeSession' | 'killSession' | 'focusSession';
  command?: string;       // For 'spawnSession': the CLI command to execute
  sessionId?: string;     // For session-specific operations
  data?: string;          // For 'writeInput': keyboard data from xterm
  cols?: number;          // For 'resizeSession': terminal columns
  rows?: number;          // For 'resizeSession': terminal rows
}

// Message types for Extension -> Webview communication
interface ExtensionMessage {
  type: 'sessionStarted' | 'sessionOutput' | 'sessionExited' | 'sessionKilled' | 'error' | 'ready';
  sessionId?: string;     // Session identifier
  command?: string;       // For 'sessionStarted': the command that was spawned
  data?: string;          // For 'sessionOutput': PTY output chunk
  code?: number;          // For 'sessionExited': process exit code
  message?: string;       // For 'error': error description
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

  private _view?: vscode.WebviewView;
  
  // Session registry - maps sessionId to Session object
  // Maintains all active sessions with isolated lifecycles
  private _sessions: Map<string, Session> = new Map();
  
  // Counter for generating unique session IDs
  private _sessionCounter = 0;

  constructor(private readonly _extensionUri: vscode.Uri) {}

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
   * - spawnSession: Create new PTY session with command
   * - writeInput: Forward keyboard input to specific session's PTY
   * - resizeSession: Adjust specific session's PTY dimensions
   * - killSession: Terminate specific session
   * - focusSession: Request session data replay for switching
   */
  private _handleMessage(message: WebviewMessage): void {
    switch (message.type) {
      case 'spawnSession':
        if (message.command) {
          this._spawnSession(message.command);
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
    }
  }

  /**
   * Generate a unique session ID.
   * Format: session-<counter>-<timestamp> for debugging clarity
   */
  private _generateSessionId(): string {
    return `session-${++this._sessionCounter}-${Date.now()}`;
  }

  /**
   * Spawn a new PTY session with the given command.
   * 
   * Design decisions:
   * - Each session gets a unique sessionId
   * - Same command can be spawned multiple times (no reuse)
   * - Uses 'which' to verify command exists in PATH
   * - No shell wrapping: spawns command directly
   * - Inherits process.env unchanged
   * - cwd is user HOME
   * - Output buffered for replay when switching sessions
   */
  private _spawnSession(command: string): void {
    const sessionId = this._generateSessionId();

    // Parse command into executable and arguments
    // Simple split on whitespace - no shell expansion
    const parts = command.trim().split(/\s+/);
    const executable = parts[0];
    const args = parts.slice(1);

    // Verify executable exists in PATH
    // Using 'which' because we're macOS-first
    const { execSync } = require('child_process');
    let resolvedPath: string;
    try {
      resolvedPath = execSync(`which ${executable}`, { encoding: 'utf8' }).trim();
    } catch {
      this._postMessage({
        type: 'error',
        sessionId,
        message: `Command not found: ${executable}`
      });
      return;
    }

    try {
      // Spawn PTY with:
      // - Resolved executable path (from which)
      // - Original arguments
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

      // Create session object
      const session: Session = {
        sessionId,
        command,
        pty: ptyProcess,
        outputBuffer: [],
        state: 'running'
      };

      // Register session
      this._sessions.set(sessionId, session);

      // Notify Webview of new session
      this._postMessage({
        type: 'sessionStarted',
        sessionId,
        command
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
   * - Session list panel showing all sessions with switch/kill controls
   * - Command input for spawning new sessions
   * - Terminal container for active session's xterm
   * - Multiple xterm instances maintained in memory, one visible at a time
   * 
   * Security:
   * - Uses Content Security Policy to restrict script sources
   * - xterm.js loaded from CDN (unpkg) - production should bundle locally
   */
  private _getHtmlForWebview(webview: vscode.Webview): string {
    // Nonce for CSP - allows only scripts with this nonce
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <!--
    Content Security Policy:
    - default-src 'none': Block all by default
    - style-src: Allow CDN styles and inline styles (for xterm)
    - script-src: Allow CDN scripts and nonce'd inline script
    - font-src: Allow CDN fonts (xterm uses custom fonts)
    - connect-src: Allow VS Code webview protocol
  -->
  <meta http-equiv="Content-Security-Policy" content="
    default-src 'none';
    style-src https://unpkg.com 'unsafe-inline';
    script-src https://unpkg.com 'nonce-${nonce}';
    font-src https://unpkg.com;
    connect-src ${webview.cspSource};
  ">
  <title>Oracle Dock</title>
  <!-- xterm.js core styles -->
  <link rel="stylesheet" href="https://unpkg.com/xterm@5.3.0/css/xterm.css">
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
    
    /* Session list panel */
    #session-panel {
      background: #252526;
      border-bottom: 1px solid #3c3c3c;
      max-height: 150px;
      overflow-y: auto;
    }
    
    /* Command input row */
    #input-row {
      display: flex;
      padding: 6px;
      gap: 4px;
      border-bottom: 1px solid #3c3c3c;
    }
    #command-input {
      flex: 1;
      padding: 4px 8px;
      background: #3c3c3c;
      border: 1px solid #555;
      color: #fff;
      font-family: monospace;
      font-size: 12px;
    }
    #command-input:focus {
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
    
    /* Session list */
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
      height: calc(100% - 150px);
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
  <!-- Session panel: input + session list -->
  <div id="session-panel">
    <div id="input-row">
      <input 
        type="text" 
        id="command-input" 
        placeholder="Enter CLI command..."
        autocomplete="off"
        spellcheck="false"
      >
      <button id="spawn-btn">+ New</button>
    </div>
    <ul id="session-list"></ul>
  </div>
  
  <div id="error-display"></div>
  
  <!-- Terminal container: holds all xterm instances, one visible at a time -->
  <div id="terminal-container">
    <div id="empty-state">No sessions. Enter a command above.</div>
  </div>

  <!-- xterm.js library -->
  <script src="https://unpkg.com/xterm@5.3.0/lib/xterm.js"></script>
  <!-- xterm-addon-fit: auto-resize terminal to container -->
  <script src="https://unpkg.com/xterm-addon-fit@0.8.0/lib/xterm-addon-fit.js"></script>

  <script nonce="${nonce}">
    (function() {
      // VS Code API for postMessage communication
      const vscode = acquireVsCodeApi();

      // DOM elements
      const commandInput = document.getElementById('command-input');
      const spawnBtn = document.getElementById('spawn-btn');
      const sessionList = document.getElementById('session-list');
      const terminalContainer = document.getElementById('terminal-container');
      const emptyState = document.getElementById('empty-state');
      const errorDisplay = document.getElementById('error-display');

      /**
       * Session registry - mirrors extension host registry
       * Each session holds:
       * - sessionId: unique identifier
       * - command: the spawned command
       * - terminal: xterm.js Terminal instance
       * - fitAddon: FitAddon instance for this terminal
       * - wrapper: DOM element containing the terminal
       * - state: 'running' | 'exited'
       * - outputBuffer: stored output for reference
       */
      const sessions = new Map();
      let activeSessionId = null;

      /**
       * Create a new xterm instance for a session.
       * Terminal is created but not attached to DOM until session becomes active.
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

        // Create wrapper div for this terminal
        const wrapper = document.createElement('div');
        wrapper.className = 'terminal-wrapper hidden';
        wrapper.id = 'terminal-' + sessionId;
        terminalContainer.appendChild(wrapper);

        // Open terminal in wrapper
        terminal.open(wrapper);
        
        // Forward keyboard input to extension host with sessionId
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
       * Switch active session - detach current, attach new.
       * Does not restart PTY - just switches DOM visibility.
       */
      function switchToSession(sessionId) {
        if (activeSessionId === sessionId) return;
        
        // Hide current active session's terminal
        if (activeSessionId && sessions.has(activeSessionId)) {
          const current = sessions.get(activeSessionId);
          current.wrapper.classList.add('hidden');
        }

        // Show new session's terminal
        const session = sessions.get(sessionId);
        if (session) {
          session.wrapper.classList.remove('hidden');
          activeSessionId = sessionId;
          
          // Fit and resize
          setTimeout(() => {
            session.fitAddon.fit();
            sendResize(sessionId, session.terminal);
            session.terminal.focus();
          }, 10);
        }

        // Update session list UI
        renderSessionList();
        
        // Hide empty state
        emptyState.style.display = 'none';
        
        // Notify extension (optional, for future use)
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
       */
      function renderSessionList() {
        sessionList.innerHTML = '';
        
        for (const [sessionId, session] of sessions) {
          const li = document.createElement('li');
          li.className = 'session-item';
          if (sessionId === activeSessionId) li.classList.add('active');
          if (session.state === 'exited') li.classList.add('exited');
          
          // State badge
          const stateBadge = document.createElement('span');
          stateBadge.className = 'session-state ' + session.state;
          stateBadge.textContent = session.state;
          
          // Command display
          const cmdSpan = document.createElement('span');
          cmdSpan.className = 'session-command';
          cmdSpan.textContent = session.command;
          
          // Kill button
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
          
          // Click to switch
          li.onclick = () => switchToSession(sessionId);
          
          sessionList.appendChild(li);
        }
      }

      /**
       * Spawn a new session with the entered command.
       */
      function spawnSession() {
        const command = commandInput.value.trim();
        if (!command) return;
        
        errorDisplay.style.display = 'none';
        vscode.postMessage({ type: 'spawnSession', command });
        commandInput.value = '';
      }

      // Event listeners
      commandInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          spawnSession();
        }
      });
      
      spawnBtn.addEventListener('click', spawnSession);

      // Handle resize for active terminal
      const resizeObserver = new ResizeObserver(() => {
        if (activeSessionId && sessions.has(activeSessionId)) {
          const session = sessions.get(activeSessionId);
          session.fitAddon.fit();
          sendResize(activeSessionId, session.terminal);
        }
      });
      resizeObserver.observe(terminalContainer);

      /**
       * Handle messages from extension host.
       * Multi-session protocol:
       * - sessionStarted: New session created
       * - sessionOutput: PTY output for specific session
       * - sessionExited: Session process terminated
       * - sessionKilled: Session removed
       * - error: Error for specific session
       * - ready: Extension ready
       */
      window.addEventListener('message', (event) => {
        const message = event.data;

        switch (message.type) {
          case 'sessionStarted': {
            const { sessionId, command } = message;
            
            // Create terminal for this session
            const { terminal, fitAddon, wrapper } = createTerminalForSession(sessionId);
            
            // Register session
            sessions.set(sessionId, {
              sessionId,
              command,
              terminal,
              fitAddon,
              wrapper,
              state: 'running',
              outputBuffer: []
            });
            
            // Auto-switch to new session
            switchToSession(sessionId);
            break;
          }

          case 'sessionOutput': {
            const { sessionId, data } = message;
            const session = sessions.get(sessionId);
            if (session && data) {
              // Buffer output
              session.outputBuffer.push(data);
              // Write to terminal
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
              // Dispose terminal
              session.terminal.dispose();
              session.wrapper.remove();
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
            }
            break;
          }

          case 'error': {
            errorDisplay.textContent = message.message;
            errorDisplay.style.display = 'block';
            break;
          }

          case 'ready': {
            commandInput.focus();
            break;
          }
        }
      });

      // Auto-focus input on load
      commandInput.focus();
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
  const provider = new OracleDockViewProvider(context.extensionUri);

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
