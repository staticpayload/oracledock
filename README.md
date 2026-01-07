# Oracle Dock

VS Code extension providing a sidebar terminal with dynamic CLI command input.

## Features

- Sidebar Webview titled "Oracle Dock"
- User enters any installed CLI command
- PTY session spawned using node-pty
- xterm.js terminal rendering with full ANSI support
- Keyboard input forwarded to PTY
- Session persists while sidebar is open

## Development

### Prerequisites

- Node.js 18+
- npm

### Setup

```bash
npm install
npm run build
```

### Running

1. Open this folder in VS Code
2. Press F5 to launch Extension Development Host
3. In the new VS Code window, find "Oracle Dock" in the Explorer sidebar
4. Enter a CLI command (e.g., `python`, `node`, `htop`)

### Architecture

```
oracledock/
├── src/
│   └── extension.ts    # Extension entry, WebviewViewProvider, PTY lifecycle
├── dist/               # Built output (gitignored)
├── package.json        # Extension manifest and dependencies
├── tsconfig.json       # TypeScript configuration
└── esbuild.config.js   # Build configuration
```

### Message Protocol

**Webview → Extension:**
- `spawn`: Request PTY with command string
- `input`: Forward keyboard data to PTY
- `resize`: Update PTY dimensions

**Extension → Webview:**
- `output`: PTY stdout/stderr data
- `error`: Error message
- `exit`: Process terminated with exit code
- `ready`: Extension initialized

## Constraints

- macOS first
- No shell wrapping
- Unmodified process.env
- cwd set to user HOME
- Single PTY session
