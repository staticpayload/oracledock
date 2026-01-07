# Oracle Dock

Oracle Dock is a right-sidebar agent CLI dock for VS Code. It launches real system CLIs in parallel PTY sessions and lets you switch between them instantly.

## Supported agents

- claude
- codex
- gemini
- droid
- kiro-cli
- kilocode
- opencode
- aider

## Core experience

- Oracle Dock opens in the right sidebar and is immediately interactive.
- Pick an agent from the dropdown and click Launch to start a new session.
- Click the same agent again to open another instance in parallel.
- Sessions list is always visible for the current workspace.
- Click a session to switch; click the kill icon and confirm to stop it.

## UI effects and indicators

- Active session header shows the agent logo and name.
- Each agent and session shows its logo in a circular badge.
- Missing agents are labeled as "Not installed" instead of failing silently.
- Terminal surface expands to maximize usable CLI space.

## How it works

- One PTY per click, no reuse.
- Command is the agent name, args are empty.
- CWD is HOME, env is your login shell environment.
- xterm renders each session and preserves output on switch.
- Sessions are scoped per workspace; on reload they restore as exited with buffered output.

## What Oracle Dock does not do

- No CLI discovery or PATH scanning.
- No profiles, presets, or setup screens.
- No shell wrapping, no env mutation, no telemetry, no remote assets.

## Install (VSIX)

1) Download the latest `.vsix` from GitHub Releases.
2) In VS Code: Extensions view -> More Actions -> Install from VSIX.

## Development

```bash
npm install
npm run build
```

Run with VS Code Extension Development Host (F5).

## Troubleshooting

- If an agent shows "Not installed", ensure it is available in your login shell PATH.
- If the panel is closed, reopen Oracle Dock from the right sidebar.
