#!/bin/bash
set -e

# =============================================================================
# sjs-browser — Entrypoint
#
# Starts Chrome with CDP and VNC, then hands off to the bootstrap which
# fetches the latest signed release tarball, verifies it, and execs the
# runtime that connects to the SJS server and relays CDP traffic.
# =============================================================================

# --- Validate required env vars ---
if [ -z "$SJS_SERVER_URL" ]; then
  echo "[FATAL] SJS_SERVER_URL is required (e.g., wss://app.smartjobseeker.com/tunnel)"
  exit 1
fi

if [ -z "$SJS_API_TOKEN" ]; then
  echo "[FATAL] SJS_API_TOKEN is required (get it from your SJS dashboard)"
  exit 1
fi

CDP_PORT=9222
VNC_PORT="${SJS_VNC_PORT:-5900}"
VNC_PASSWORD="${SJS_VNC_PASSWORD:-secret}"
SESSION_DIR="/data/sessions/chrome-user-data"
SOCAT_BIND_ADDR="127.0.0.1"

# Start Chrome + VNC + socat (shared logic)
source /chrome-common.sh

echo "============================================"
echo " Smart Job Seeker — sjs-browser"
echo "   VNC:    port $VNC_PORT"
echo "   Server: $SJS_SERVER_URL"
echo "============================================"

# Hand off to the bootstrap, which fetches the latest signed release
# tarball, verifies its signature, swaps the /data/app/current symlink,
# and exec's the runtime. Falls back to the baked image source if the
# fetch / verification fails.
exec /sjs-browser/bootstrap.sh
