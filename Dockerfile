# Smart Job Seeker — sjs-browser
#
# Provides Chrome + the SJS browser channel client in a single container.
# Users run this on their NAS (TrueNAS, Synology, Unraid, QNAP) to scrape
# with their home IP without needing a desktop app.
#
# Services:
#   - Chrome with CDP (headful via Xvfb, visible via VNC)
#   - VNC on port 5900 (for manual intervention via noVNC/VNC client)
#   - bootstrap.sh, which on startup fetches the latest signed release
#     tarball from gitaarik/sjs-browser, verifies it, and runs it
#
# Required env vars:
#   SJS_SERVER_URL  — WebSocket tunnel URL (e.g., wss://app.smartjobseeker.com/tunnel)
#   SJS_API_TOKEN   — API token from the SJS dashboard
#
# Optional env vars:
#   SJS_VNC_PORT        — VNC port (default 5900)
#   SJS_PROXY_URL       — Residential proxy URL for Chrome
#   SJS_VNC_PASSWORD    — VNC password (default "secret")
#   SJS_BROWSER_CHANNEL — "stable" (default), a pinned tag like "v0.5.27",
#                         or "disabled" to skip the bootstrap auto-update
#
# Build context is the repo root (all sources live here, including the
# vendored chrome-common.sh shared with the cloud chrome/ dev image):
#   docker build -t sjs-browser .

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV DISPLAY=:99

# Build metadata — passed by the release script and surfaced in the startup
# log so users can verify which image their TrueNAS app is actually running.
ARG SJS_BROWSER_BUILD_VERSION=dev
ARG SJS_BROWSER_BUILD_DATE=unknown
ENV SJS_BROWSER_BUILD_VERSION=${SJS_BROWSER_BUILD_VERSION}
ENV SJS_BROWSER_BUILD_DATE=${SJS_BROWSER_BUILD_DATE}

# Default channel for the bootstrap auto-update. `stable` (the release default)
# fetches the latest signed tarball from GitHub on every start. `disabled`
# skips the fetch so the baked code runs — required for the beta image,
# whose whole point is to ship unreleased code for testing. Users can still
# override per-container via the SJS_BROWSER_CHANNEL env var.
ARG SJS_BROWSER_DEFAULT_CHANNEL=stable
ENV SJS_BROWSER_CHANNEL=${SJS_BROWSER_DEFAULT_CHANNEL}

# Install Chrome, Xvfb, VNC, socat, Node.js, and dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chrome dependencies
    wget gnupg ca-certificates fonts-liberation \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0 libnspr4 libnss3 libxcomposite1 \
    libxdamage1 libxfixes3 libxrandr2 libxshmfence1 xdg-utils \
    # Display and VNC
    xvfb x11vnc \
    # Real X11 keypress injection (for typing on auth-protected sites)
    xdotool \
    # X11 screen capture for debug screenshots (off the Chrome CDP queue,
    # so debug captures don't starve clickAt acks during login flows)
    scrot \
    # Port forwarding
    socat \
    # Process supervisor
    tini \
    # Health check + bootstrap fetch
    curl \
    # JSON parsing for preferences + bootstrap manifest parsing
    jq \
    && rm -rf /var/lib/apt/lists/*

# minisign for bootstrap signature verification — installed from upstream
# release tarballs because Ubuntu 22.04 doesn't carry it (added in later
# releases). Pinned to 0.11 to match the host install used to sign
# tarballs in release.sh; bump together if either side moves.
ARG TARGETARCH=amd64
RUN MINISIGN_ARCH=$(case "$TARGETARCH" in amd64) echo x86_64;; arm64) echo aarch64;; *) echo "unsupported arch: $TARGETARCH" >&2; exit 1;; esac) \
    && curl -fsSL https://github.com/jedisct1/minisign/releases/download/0.11/minisign-0.11-linux.tar.gz \
       | tar xz -C /tmp \
    && install -m 0755 "/tmp/minisign-linux/${MINISIGN_ARCH}/minisign" /usr/local/bin/minisign \
    && rm -rf /tmp/minisign-linux

# Install Google Chrome stable
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 20 LTS
RUN curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Create data directory for Chrome profile persistence
RUN mkdir -p /data/sessions/chrome-user-data

# Copy tunnel client source
WORKDIR /sjs-browser
COPY package.json tsconfig.json ./
COPY src/ ./src/
RUN npm install

# Public key the bootstrap uses to verify downloaded release tarballs.
COPY release.pub /sjs-browser/release.pub

# Shared Chrome startup logic (vendored copy; canonical source is the cloud
# chrome/ image — keep the two in sync, see chrome-build-unification).
COPY chrome-common.sh /chrome-common.sh
COPY entrypoint.sh /entrypoint.sh
COPY bootstrap.sh /sjs-browser/bootstrap.sh
RUN chmod +x /chrome-common.sh /entrypoint.sh /sjs-browser/bootstrap.sh

# Health check — verify Chrome CDP is responsive
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -sf http://127.0.0.1:9222/json/version > /dev/null || exit 1

# Use tini as PID 1 for proper signal handling and zombie reaping
ENTRYPOINT ["tini", "--"]
CMD ["/entrypoint.sh"]
