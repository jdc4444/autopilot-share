#!/bin/bash
# Autopilot Codex — one-command setup
set -e

echo "=== Autopilot Codex Setup ==="
echo ""

# Check Node.js
if ! command -v node &>/dev/null; then
  echo "ERROR: Node.js is required. Install from https://nodejs.org"
  exit 1
fi
NODE_V=$(node -v)
echo "Node.js: $NODE_V"

# Check Python 3 (needed for send_to_codex.py)
if ! command -v python3 &>/dev/null; then
  echo "WARNING: python3 not found. Message sending to Codex won't work."
else
  echo "Python3: $(python3 --version 2>&1)"
fi

# Check Codex CLI
CODEX_PATH=""
for p in "/Applications/Codex.app/Contents/Resources/codex" /opt/homebrew/bin/codex /usr/local/bin/codex; do
  if [ -x "$p" ]; then
    CODEX_PATH="$p"
    break
  fi
done
if [ -z "$CODEX_PATH" ]; then
  CODEX_PATH=$(which codex 2>/dev/null || true)
fi
if [ -n "$CODEX_PATH" ]; then
  echo "Codex CLI: $CODEX_PATH"
else
  echo "WARNING: Codex CLI not found. Brain features won't work."
  echo "  Install or open Codex.app first so the bundled CLI is available."
fi

echo ""

# Install dependencies
echo "Installing dependencies..."
npm install

echo ""

# Create knowledge directory
mkdir -p knowledge

# Make send script executable
chmod +x send_to_codex.py

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
