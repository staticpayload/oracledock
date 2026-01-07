# Oracle Dock

Oracle Dock is a right-sidebar agent CLI dock for VS Code. It launches real system CLIs in parallel sessions and lets you switch between them instantly.

## Supported agents

- claude
- codex
- gemini
- droid
- kiro-cli
- kilocode
- opencode
- aider

## Quick start

1) Install the agent CLI(s) so they are available in your login shell PATH.
2) Open Oracle Dock in the right sidebar.
3) Pick an agent from the dropdown and click Launch.
4) Click a session to switch; click the kill icon and confirm to stop it.

## Behavior

- One PTY per click, no reuse.
- Command is the agent name, args are empty.
- CWD is HOME, env is your login shell environment.
- xterm renders each session and preserves output when you switch.
- Sessions are scoped per workspace; on reload they restore as exited with buffered output.
- Missing agents are shown as "Not installed" instead of failing silently.

## What Oracle Dock does not do

- No CLI discovery or PATH scanning.
- No profiles, presets, or setup screens.
- No shell wrapping, no env mutation, no telemetry, no remote assets.

## Development

```bash
npm install
npm run build
```

Run with VS Code Extension Development Host (F5).

## Troubleshooting

- If an agent shows "Not installed", ensure it is available in your login shell PATH.
- If the panel is closed, reopen Oracle Dock from the right sidebar.
