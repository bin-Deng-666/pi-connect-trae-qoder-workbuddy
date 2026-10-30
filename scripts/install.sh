#!/usr/bin/env bash
#
# Install (or remove) a launch agent that keeps the gateway running.
#
# WHY A LAUNCH AGENT AND NOT A SHELL PROFILE LINE. The gateway has to be up
# whenever pi is, including in a terminal that was opened before this was set up.
# A `nohup node … &` in a profile starts a new copy per shell and leaves orphans;
# launchd starts exactly one, restarts it if it dies, and reaps it at logout.
#
# Usage:
#   ./scripts/install.sh              # install and start
#   ./scripts/install.sh --uninstall  # stop and remove
set -euo pipefail

LABEL="com.pi-connect.gateway"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/.pi/agent/pi-connect.log"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "removed $LABEL"
  echo "log left at $LOG"
  exit 0
fi

NODE="$(command -v node || true)"
if [[ -z "$NODE" ]]; then
  echo "node not found on PATH; install Node >= 22.5 first" >&2
  exit 1
fi

# `node:sqlite` is what bin/catalog.mjs needs, and it is the reason for the
# version floor. Checking here turns a confusing runtime error later into a clear
# one now.
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 22 )); then
  echo "Node $("$NODE" -v) is too old; need >= 22.5 for node:sqlite" >&2
  exit 1
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"

# Unload first so a re-run replaces the job instead of failing on the duplicate.
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$ROOT/src/gateway.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
PLIST_EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"
launchctl kickstart -k "gui/$(id -u)/$LABEL"

# Give it a moment, then report the truth rather than assuming success.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 0.4
  if curl -fsS "http://127.0.0.1:8798/healthz" >/dev/null 2>&1; then
    echo "installed $LABEL"
    echo "  health: $(curl -fsS http://127.0.0.1:8798/healthz)"
    echo "  log:    $LOG"
    exit 0
  fi
done

echo "installed $LABEL but it is not answering on port 8798 yet." >&2
echo "check the log: $LOG" >&2
exit 1
