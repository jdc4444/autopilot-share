# Autopilot Share

Smart autopilot for Claude Code that watches your Claude Desktop sessions, identifies insights, and sends contextual messages when idle.

## What It Does

- **Monitors Claude Desktop** via screenshots and idle detection
- **Scans your Claude Code threads** to understand what you're working on
- **AI brain** (Claude Opus via Agent SDK) analyzes context and generates insights
- **Auto-sends suggestions** to Claude Desktop when it detects idle periods
- **Tracks findings** with a full lifecycle: identified → sent → received → implemented
- **Goal system** to focus the brain on what matters to you
- **CLI pilot tab** for managing Claude Code via tmux

## Requirements

- **macOS** (uses screencapture + AppleScript)
- **Node.js** 18+
- **Claude Code CLI** installed (`claude` command available)
- **Claude Desktop** app (for message sending)
- **Screen Recording permission** for Node.js (System Settings → Privacy → Screen Recording)

## Quick Start

```bash
git clone <this-repo>
cd autopilot-share
bash setup.sh
npm start
```

Open http://localhost:3460 in your browser.

## Configuration

| Env Variable | Default | Description |
|---|---|---|
| `AUTOPILOT_CWD` | Current directory | Working directory for project scanning |
| `PORT` | 3460 | Server port |

## How It Works

1. **Screenshot loop** captures Claude Desktop window every cycle
2. **Idle detection** checks if the input area has changed (MD5 hash of bottom 200px)
3. When idle, the **brain** (Agent SDK) analyzes the screenshot + thread context
4. Brain generates findings/insights and suggested prompts
5. Suggestions auto-send to Claude Desktop after a brief preview window
6. The **dashboard** shows real-time brain activity, findings, and goals

## Dashboard Tabs

- **Chat** — Talk to the brain directly, see its thinking process
- **Tracker** — View all findings, goals, and screenshot previews
- **CLI** — Queue messages for Claude Code via tmux integration

## Project Structure

```
server.js          — Main server: HTTP, WebSocket, brain orchestration
brain-worker.js    — Isolated child process for Agent SDK calls
electron.js        — Optional Electron wrapper
send_to_claude.py  — AppleScript message sender for Claude Desktop
index.html         — Single-file dashboard UI
knowledge/         — Persisted state (findings, goals, thread digests)
```

## License

MIT
