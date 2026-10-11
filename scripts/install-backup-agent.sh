#!/bin/bash
# Installs the macOS launchd agent that runs scripts/auto-backup.sh every 900 seconds.
set -e
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.filmybase.autobackup"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
[ "$(uname)" = "Darwin" ] || { echo "This installer is for macOS (launchd)."; exit 1; }
chmod +x "$REPO/scripts/auto-backup.sh"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$REPO/scripts/auto-backup.sh</string></array>
  <key>StartInterval</key><integer>900</integer>
  <key>RunAtLoad</key><true/>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>StandardErrorPath</key><string>$REPO/auto-backup.log</string>
  <key>StandardOutPath</key><string>$REPO/auto-backup.log</string>
</dict>
</plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Installed. It runs every 900 seconds while the Mac is awake. Log: $REPO/auto-backup.log"
