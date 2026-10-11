#!/bin/bash
# Turns the automatic backup off and removes the launchd agent.
LABEL="com.filmybase.autobackup"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Stopped." || echo "It was not running."
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" && echo "Removed the agent file."
