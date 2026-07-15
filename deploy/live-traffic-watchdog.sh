#!/bin/bash
# Watchdog for the StillOS live traffic feed (core/live_traffic_server.cjs).
# Tails the nolawealth Caddy log, classifies hits (internal/bot/browser), enriches
# external IPs via ip-api.com, streams over SSE to the tailnet-only dashboard.
# No root, no LLM calls, no money movement. Kill switch:
# state/live-traffic/live-traffic-kill.json (presence = stay down; also makes the
# process itself refuse to start / shut down mid-run).
set -u
SCRIPT="/home/marcus/core/live_traffic_server.cjs"
LOG="/home/marcus/logs/live-traffic-server.log"
KILL="/home/marcus/still-os-consciousness/state/live-traffic/live-traffic-kill.json"

if [ -f "$KILL" ]; then exit 0; fi
if pgrep -f "node $SCRIPT" > /dev/null 2>&1; then exit 0; fi

echo "[$(date -Iseconds)] watchdog: live traffic server not running, starting" >> "$LOG"
cd /home/marcus/still-os-consciousness
setsid /usr/bin/node "$SCRIPT" < /dev/null >> "$LOG" 2>&1 &
disown
