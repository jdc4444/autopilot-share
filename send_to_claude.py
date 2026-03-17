#!/usr/bin/env python3
"""Send a message to Claude Desktop's currently open conversation.
Usage: send_to_claude.py <message>

Clicks the input field first (Electron needs focus), then types via keystroke.
Cmd-V paste does NOT work in Claude Desktop's Electron input.
"""
import sys
import subprocess


def send(message):
    # Escape for AppleScript string
    escaped = message.replace('\\', '\\\\').replace('"', '\\"')

    # Scale delay after keystroke: ~0.5s base + 0.5s per 100 chars
    type_delay = round(0.5 + len(message) * 0.005, 1)
    timeout = max(30, int(type_delay + 10))

    script = f'''
    tell application "Claude" to activate
    delay 0.5

    tell application "System Events"
        tell process "Claude"
            set frontmost to true
            delay 0.3

            -- Click input field (bottom center of window)
            set winPos to position of window 1
            set winSize to size of window 1
            set xCenter to (item 1 of winPos) + ((item 1 of winSize) / 2)
            set yInput to (item 2 of winPos) + (item 2 of winSize) - 80

            click at {{xCenter, yInput}}
            delay 0.3

            keystroke "{escaped}"
            delay {type_delay}

            -- Re-focus Claude before Enter in case another app stole focus
            set frontmost to true
            delay 0.2
            key code 36
        end tell
    end tell
    '''

    result = subprocess.run(
        ["osascript", "-e", script],
        capture_output=True, text=True, timeout=timeout
    )

    if result.returncode != 0:
        print(f"ERROR: {result.stderr.strip()}", file=sys.stderr)
        return False

    return True


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: send_to_claude.py <message>")
        sys.exit(1)

    message = " ".join(sys.argv[1:])

    if send(message):
        print("ok")
    else:
        sys.exit(1)
