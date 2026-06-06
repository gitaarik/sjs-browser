#!/bin/bash
# =============================================================================
# Shared Chrome + VNC startup logic
#
# Sourced by both chrome/entrypoint.sh and sjs-browser/entrypoint.sh.
# Starts Xvfb, VNC, Chrome with CDP, and socat for port forwarding.
#
# Required vars (set before sourcing):
#   CDP_PORT           — External CDP port (e.g. 9222)
#   VNC_PORT           — VNC port (e.g. 5900)
#   VNC_PASSWORD       — VNC password (default: secret)
#   SESSION_DIR        — Chrome user data directory
#   SOCAT_BIND_ADDR    — socat bind address: "0.0.0.0" (chrome) or "127.0.0.1" (tunnel)
#   EXTRA_CHROME_ARGS  — Array of extra Chrome flags (optional)
#
# Exports after sourcing:
#   CHROME_PID, VNC_PID, XVFB_PID, SOCAT_PID
# =============================================================================

INTERNAL_CDP_PORT=$((CDP_PORT + 1))

# --- Chrome preferences setup ---
setup_preferences() {
  local user_data_dir="${1:-$SESSION_DIR}"
  local prefs_dir="$user_data_dir/Default"
  local prefs_file="$prefs_dir/Preferences"
  mkdir -p "$prefs_dir"

  local prefs="{}"
  if [ -f "$prefs_file" ]; then
    prefs=$(cat "$prefs_file" 2>/dev/null || echo "{}")
  fi

  prefs=$(echo "$prefs" | jq '
    .credentials_enable_service = false |
    .profile.password_manager_enabled = false |
    .profile.exit_type = "Normal" |
    .profile.exited_cleanly = true |
    .session.restore_on_startup = 1 |
    .browser.show_home_button = false
  ')

  echo "$prefs" > "$prefs_file"
  echo "[Chrome] Preferences configured"
}

# --- Session data cleanup (clear tabs but keep cookies/login) ---
cleanup_session_data() {
  local user_data_dir="${1:-$SESSION_DIR}"
  for dir in "$user_data_dir/Default/Sessions" "$user_data_dir/Default/Session Storage"; do
    if [ -d "$dir" ]; then
      rm -rf "$dir"
      mkdir -p "$dir"
      echo "[Chrome] Cleared: $dir"
    fi
  done
}

# --- Remove stale lock files ---
cleanup_locks() {
  local user_data_dir="${1:-$SESSION_DIR}"
  rm -f "$user_data_dir"/Singleton* 2>/dev/null || true
}

# --- Pick a consistent viewport size seeded by session dir ---
get_viewport() {
  local sizes=("1920,1080" "1536,864" "1440,900" "1366,768" "1600,900" "1680,1050" "1280,800" "1280,720")
  local hash=$(echo -n "$SESSION_DIR" | md5sum | cut -c1-8)
  local index=$(( 16#$hash % ${#sizes[@]} ))
  echo "${sizes[$index]}"
}

# --- Per-credential profile switching ---
# The sjs-browser tunnel runtime writes the desired Chrome user-data dir to
# DESIRED_PROFILE_FILE so each platform account keeps its own cookies /
# remember-me state. The supervisor below relaunches Chrome on it and echoes
# the live dir into CURRENT_PROFILE_FILE (which the runtime waits on so it
# doesn't bridge to the previous account's CDP). When unset — the local-chrome
# image, or an older server that doesn't send a profile id — it falls back to
# the shared $SESSION_DIR. The value is validated to stay under /data/sessions.
DESIRED_PROFILE_FILE="/data/sessions/.desired-profile-dir"
CURRENT_PROFILE_FILE="/data/sessions/.current-profile-dir"

resolve_desired_profile_dir() {
  local dir=""
  if [ -f "$DESIRED_PROFILE_FILE" ]; then
    dir=$(head -c 256 "$DESIRED_PROFILE_FILE" 2>/dev/null | tr -d '\r\n')
  fi
  case "$dir" in
    /data/sessions/chrome-profiles/profile-*|"$SESSION_DIR") echo "$dir" ;;
    *) echo "$SESSION_DIR" ;;
  esac
}

# =============================================================================
# Start services
# =============================================================================

# 1. Xvfb (virtual display)
rm -f /tmp/.X99-lock
Xvfb :99 -ac -screen 0 1920x1080x24 -nolisten tcp &
XVFB_PID=$!
sleep 2

if ! kill -0 $XVFB_PID 2>/dev/null; then
  echo "[FATAL] Xvfb failed to start"
  exit 1
fi
echo "[Xvfb] Started on display :99"

# 2. VNC server
x11vnc -display :99 \
  -rfbport "$VNC_PORT" \
  -listen 0.0.0.0 \
  -N -forever \
  -passwd "${VNC_PASSWORD:-secret}" \
  -shared \
  -noxdamage \
  2>/dev/null &
VNC_PID=$!
sleep 1
echo "[VNC] Started on port $VNC_PORT"

# 3. Prepare Chrome. Per-launch prep (preferences, session cleanup, locks) runs
#    inside the supervisor loop below, since the active user-data dir can change
#    per session (per-credential profiles).
VIEWPORT=$(get_viewport)
echo "[Chrome] Using viewport: $VIEWPORT"

CHROME_ARGS=(
  --remote-debugging-port="$INTERNAL_CDP_PORT"
  --remote-debugging-address=0.0.0.0
  --no-sandbox
  --no-first-run
  --no-default-browser-check
  --disable-background-networking
  --disable-sync
  --disable-translate
  --disable-dev-shm-usage
  # Disable GPU — running on Xvfb, no real GPU available.
  # Without this, Chrome's software GL renderer burns ~100% CPU idle.
  --disable-gpu
  --disable-software-rasterizer
  # Prevent timer/renderer throttling that causes CDP WebSocket hangs
  --disable-background-timer-throttling
  --disable-renderer-backgrounding
  --disable-backgrounding-occluded-windows
  --disable-ipc-flooding-protection
  --disable-features=CalculateNativeWinOcclusion
  # Window size
  --window-size="$VIEWPORT"
  --window-position=0,0
  # Disable session restore and crash prompts
  --disable-session-crashed-bubble
  --hide-crash-restore-bubble
  --no-restore-state
  # Disable password manager prompts
  --password-store=basic
  --disable-save-password-bubble
  # Anti-bot stealth flags
  --disable-blink-features=AutomationControlled
  --disable-infobars
  # WebRTC leak prevention
  --webrtc-ip-handling-policy=disable_non_proxied_udp
  --enforce-webrtc-ip-permission-check
  # NOTE: --user-data-dir is appended per-launch in the supervisor loop below —
  #       it varies per credential (see resolve_desired_profile_dir).
)

# Add any extra flags from the consumer
if [ ${#EXTRA_CHROME_ARGS[@]} -gt 0 ]; then
  CHROME_ARGS+=("${EXTRA_CHROME_ARGS[@]}")
fi

# Optional proxy support
if [ -n "$SJS_PROXY_URL" ]; then
  CHROME_ARGS=(--proxy-server="$SJS_PROXY_URL" "${CHROME_ARGS[@]}")
  echo "[Chrome] Using proxy: $SJS_PROXY_URL"
fi

# 4. Launch Chrome under a supervisor that respawns it if it exits, and also
# relaunches it on a different user-data dir when the runtime requests a
# per-credential profile switch (via DESIRED_PROFILE_FILE).
#
# Chrome quits when the user closes the last window (e.g. via VNC after
# clicking "Open Browser"). Without respawning, the tunnel client stays
# connected to a dead Chrome and the next CDP call fails with
# "Chrome CDP not available". 1 s backoff caps respawn rate.
(
  while true; do
    UDD=$(resolve_desired_profile_dir)
    setup_preferences "$UDD"
    cleanup_session_data "$UDD"
    cleanup_locks "$UDD"
    echo "$UDD" > "$CURRENT_PROFILE_FILE"
    echo "[Chrome] Launching on profile dir: $UDD"
    google-chrome-stable "${CHROME_ARGS[@]}" --user-data-dir="$UDD" about:blank &
    CHROME_CHILD=$!
    # Respawn onto a new profile dir as soon as the runtime requests one.
    while kill -0 "$CHROME_CHILD" 2>/dev/null; do
      if [ "$(resolve_desired_profile_dir)" != "$UDD" ]; then
        echo "[Chrome] Desired profile changed -> restarting Chrome"
        kill "$CHROME_CHILD" 2>/dev/null || true
        break
      fi
      sleep 1
    done
    wait "$CHROME_CHILD" 2>/dev/null || true
    echo "[Chrome] Process exited (code $?), respawning in 1s..."
    sleep 1
  done
) &
CHROME_PID=$!
echo "[Chrome] Supervisor started (PID $CHROME_PID), waiting for CDP on port $INTERNAL_CDP_PORT..."

# Wait for CDP to be ready
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$INTERNAL_CDP_PORT/json/version" > /dev/null 2>&1; then
    echo "[Chrome] CDP ready on internal port $INTERNAL_CDP_PORT"
    break
  fi
  if ! kill -0 $CHROME_PID 2>/dev/null; then
    echo "[FATAL] Chrome process died"
    exit 1
  fi
  sleep 0.5
done

if ! curl -sf "http://127.0.0.1:$INTERNAL_CDP_PORT/json/version" > /dev/null 2>&1; then
  echo "[FATAL] CDP not ready after 15 seconds"
  exit 1
fi

# 5. socat for port forwarding (external CDP port -> internal CDP port)
socat TCP-LISTEN:"$CDP_PORT",fork,reuseaddr,bind="${SOCAT_BIND_ADDR:-0.0.0.0}" TCP:127.0.0.1:"$INTERNAL_CDP_PORT" &
SOCAT_PID=$!
sleep 0.5

if ! kill -0 $SOCAT_PID 2>/dev/null; then
  echo "[FATAL] socat failed to start"
  exit 1
fi
echo "[socat] Forwarding ${SOCAT_BIND_ADDR:-0.0.0.0}:$CDP_PORT -> 127.0.0.1:$INTERNAL_CDP_PORT"
