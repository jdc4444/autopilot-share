#!/bin/bash
# Autopilot Share — one-command setup
set -e

echo "=== Autopilot Setup ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required. Install from https://nodejs.org"
  exit 1
fi
NODE_V=$(node -v)
echo "Node.js: $NODE_V"

# Check Python 3 (needed for send_to_claude.py)
if ! command -v python3 &>/dev/null; then
  echo "WARNING: python3 not found. Message sending to Claude Desktop won't work."
else
  echo "Python3: $(python3 --version 2>&1)"
fi

# Check Claude Code CLI
CLAUDE_PATH=""
for p in "$HOME/.claude/local/claude" /opt/homebrew/bin/claude /usr/local/bin/claude; do
  if [ -x "$p" ]; then
    CLAUDE_PATH="$p"
    break
  fi
done
if [ -z "$CLAUDE_PATH" ]; then
  CLAUDE_PATH=$(which claude 2>/dev/null || true)
fi
if [ -n "$CLAUDE_PATH" ]; then
  echo "Claude CLI: $CLAUDE_PATH"
else
  echo "WARNING: Claude Code CLI not found. Brain features won't work."
  echo "  Install: https://docs.anthropic.com/en/docs/claude-code"
fi

echo ""

# Install dependencies
echo "Installing dependencies..."
npm install

echo ""

# Create knowledge directory
mkdir -p knowledge

# Make send script executable
chmod +x send_to_claude.py

echo ""
echo "=== Setup Complete ==="
echo ""
echo "Start the server:"
echo "  npm start          # Web dashboard on http://localhost:3460"
echo ""
echo "Or run as Electron app:"
echo "  npm run app"
echo ""
echo "Optional: Set working directory for project scanning:"
echo "  AUTOPILOT_CWD=~/projects npm start"
echo ""
