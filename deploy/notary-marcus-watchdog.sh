#!/bin/bash
# Watchdog for the marcus-owned notary service. Run every minute by cron.
# If the service isn't running, start it, detached, logged. No root involved.
#
# UPDATED 2026-07-14: launches inside an unprivileged bwrap jail (closes
# issue-001/risk-002, CRITICAL/HIGH -- an RCE in this internet-facing process
# previously had full marcus-user filesystem access). See
# core/notary_bwrap_wrapper.sh for exactly what's exposed inside the jail
# (verified empirically before this was wired in: SSH keys and secrets/*.env
# are invisible, only notary-admin.key is readable, unrelated business code
# is not mounted). Networking stays shared -- this is a filesystem boundary.
set -u
WRAPPER="/home/marcus/core/notary_bwrap_wrapper.sh"
LOG="/home/marcus/logs/notary-service-marcus.log"

if pgrep -f "node /home/marcus/core/notary_service_marcus.cjs" > /dev/null 2>&1; then
  exit 0
fi

echo "[$(date -Iseconds)] watchdog: service not running, starting it (jailed)" >> "$LOG"
set -a
source /home/marcus/still-os-consciousness/secrets/calibrate-mainnet.env
set +a
# x402 v2 (2026-07-14, Marcus go-live): switches the payment gate to the v2 SDK
# (@x402/express, Bazaar discovery extension emitted in every 402). Proven in
# isolated scratch first (ports 8468/8486/8489/8490) against the same live
# self-hosted facilitator. NODE_PATH must reach the vendored v2 tree INSIDE the
# bwrap jail -- /home/marcus/core is already ro-bound there. Instant rollback:
# unset USE_X402_V2 here and restart; the v1 path is untouched and still live.
export USE_X402_V2=true
export NODE_PATH=/home/marcus/core/vendor/x402v2/node_modules
setsid "$WRAPPER" 8466 < /dev/null >> "$LOG" 2>&1 &
disown
