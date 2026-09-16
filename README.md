# Autopilot Codex

Smart autopilot for Codex that watches your Codex desktop sessions, identifies insights, and sends contextual messages when idle.

## What It Does

- **Monitors Codex** via screenshots and idle detection
- **Scans your Codex threads** from `~/.codex/sessions`
- **AI brain** (Codex CLI via `codex exec --json`) analyzes context and generates insights
- **Auto-sends suggestions** to Codex when it detects idle periods
- **Tracks findings** with a full lifecycle: identified → sent → received → implemented
- **Goal system** to focus the brain on what matters to you
- **CLI pilot tab** for managing Codex via tmux

## Requirements

- **macOS** (uses screencapture + AppleScript)
- **Node.js** 18+
- **Codex CLI** installed (`codex` command available)
- **Codex** desktop app (for message sending)
- **Screen Recording permission** for Node.js (System Settings → Privacy → Screen Recording)

## Quick Start

```bash
git clone <this-repo>
cd autopilot-codex
bash setup.sh
npm start
```

Open http://localhost:3460 in your browser.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `AUTOPILOT_CWD` | Current directory | Working directory for project scanning |
| `AUTOPILOT_MODEL` | `gpt-5.4` | Codex model used for the brain worker |
| `PORT` | 3460 | Server port |

## How It Works

1. **Screenshot loop** captures the Codex window every cycle
2. **Idle detection** checks if the input area has changed (MD5 hash of bottom 200px)
3. When idle, the **brain** (`codex exec --json`) analyzes the screenshot + thread context
4. Brain generates findings/insights and suggested prompts
5. Suggestions auto-send to Codex after a brief preview window
6. The **dashboard** shows real-time brain activity, findings, and goals

## Dashboard Tabs

- **Chat** — Talk to the brain directly, see its thinking process
- **Tracker** — View all findings, goals, and screenshot previews
- **CLI** — Queue messages for Codex via tmux integration

## Project Structure

```
server.js          — Main server: HTTP, WebSocket, brain orchestration
brain-worker.js    — Isolated child process for `codex exec --json` calls
electron.js        — Optional Electron wrapper
send_to_codex.py   — AppleScript message sender for Codex
index.html         — Single-file dashboard UI
knowledge/         — Persisted state (findings, goals, thread digests)
```

## License

MIT
