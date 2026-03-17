# autopilot-share

AI monitoring and automation system that watches Claude Desktop and sends contextual messages when idle.

## Architecture

- **server.js** — Main Node.js server (~2400 lines). Runs on port 3460. Handles:
  - Screenshot capture of Claude Desktop window via `screencapture` + JXA window ID lookup
  - Idle detection via MD5 hash of bottom 200px (input area)
  - Brain cycles: builds context prompt, forks brain-worker.js, parses JSON response
  - Message sending via `send_to_claude.py` (AppleScript keystroke typing)
  - WebSocket dashboard with real-time state broadcasting
  - Knowledge system: thread scanner, findings tracker, goals
  - HTTP API: `/api/screenshot`, `/api/queue-continue`, `/api/finding-status`, `/api/goals`
  - Auto-detects Claude CLI path, Node.js path, memory directory, and session directories

- **brain-worker.js** — Isolated child process for Agent SDK `query()` calls. Forked by server.js so brain crashes can't take down the server.

- **index.html** — Single-file dashboard UI. Three tabs: Chat, Tracker, CLI. Dark/light mode.

- **send_to_claude.py** — Types messages into Claude Desktop via AppleScript.

- **electron.js** — Optional Electron wrapper.

- **knowledge/** — Persisted state (findings.json, goals.json, thread-digest.json, etc.)

## Key Patterns

- `APP_DIR = __dirname` — all paths relative to install location
- `USER_CWD = process.env.AUTOPILOT_CWD || process.cwd()` — configurable project root
- `findClaude()` / `findSystemNode()` — auto-detect CLI paths at startup
- Brain worker is forked with 5-minute timeout for crash isolation
- Three-layer dedup in sendToApp(): exact-match, word-similarity, cooldown
- Context rotation at 150K tokens to prevent unbounded growth

## Running

```bash
npm start               # Server on :3460
AUTOPILOT_CWD=~/projects npm start  # Custom project directory
npm run app             # Electron app
```
