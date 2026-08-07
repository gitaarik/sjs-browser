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

FROM ubuntu:26.04

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
    # ...the t64 suffixes are the 64-bit-time_t ABI renames; Ubuntu 24.04+
    # ships these as virtual packages only, so the bare names don't resolve.
    libasound2t64 libatk-bridge2.0-0t64 libatk1.0-0t64 libcups2t64 libdbus-1-3 \
    libdrm2 libgbm1 libgtk-3-0t64 libnspr4 libnss3 libxcomposite1 \
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
    # Unpacking the Node.js .tar.xz below (not in the base image)
    xz-utils \
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

# Install Google Chrome, pinned to the version patchright drives.
#
# WHY PINNED: patchright is pinned (^1.61.1) and targets Chromium
# 149.0.7827.55. An unpinned `google-chrome-stable` walks away from that on
# every rebuild, silently — a rebuild on 2026-08-07 moved this image from
# 149.0.7827.53 to 150.0.7871.114, leaving the browser a major version ahead of
# the library driving it, with nothing in the build to say so.
#
# 150 is a particularly bad place to land: upstream Playwright went 149 (1.61)
# straight to 151 (1.62) and skipped it, so no release of either library was
# ever built against it.
#
# WHY A POOL .deb RATHER THAN `apt-get install pkg=<version>`: Google's apt repo
# only ever indexes the CURRENT release, so a version pin against it works for
# about a week and then fails permanently. The versioned .deb stays in the pool.
# That decay has already started here — patchright's exact target, .55, is gone;
# .53 is the only 149 build Google still serves.
#
# The checksum is not ceremony. Pinning a version without pinning the bytes
# leaves a browser binary — the thing that renders untrusted pages — resolved by
# hostname alone.
#
# BUMPING: match the major that the pinned patchright expects, readable from
# node_modules/patchright-core/browsers.json. Expect 151 next, not 150.
#
# amd64 only, unchanged: Google ships no arm64 Chrome for Linux, and the repo
# line this replaces was already `arch=amd64`. The guard makes that explicit
# instead of surfacing as "Unable to locate package" four layers on.
ARG CHROME_VERSION=149.0.7827.53-1
ARG CHROME_SHA256=8aa34d8c9cbd5a37b98dca49ad0607bbf819a6d681c19834599cdb65329498f8
RUN set -eu \
    && case "$TARGETARCH" in \
         amd64) ;; \
         *) echo "google-chrome-stable is amd64-only; unsupported arch: $TARGETARCH" >&2; exit 1;; \
       esac \
    && wget -q -O /tmp/google-chrome.deb \
       "https://dl.google.com/linux/chrome/deb/pool/main/g/google-chrome-stable/google-chrome-stable_${CHROME_VERSION}_amd64.deb" \
    && echo "${CHROME_SHA256}  /tmp/google-chrome.deb" | sha256sum -c - \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/google-chrome.deb \
    && rm /tmp/google-chrome.deb \
    && apt-mark hold google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# `apt-mark hold` above is load-bearing, not belt-and-braces: Chrome's own
# postinst re-adds Google's apt repo, so without the hold any later
# `apt-get upgrade` in this or a downstream layer would walk straight past the
# pin and undo everything above.

# Install Node.js LTS from the official nodejs.org tarball.
#
# NOT via NodeSource's apt repo: its setup script logs a failed signing-key
# fetch but still exits 0, so when deb.nodesource.com started 403ing (2026-07-27)
# the repo was never added, apt silently fell back to Ubuntu's own `nodejs`
# package — which ships no npm — and the build only died four layers later on
# `npm install`. Upstream tarballs need no third-party key, and are built
# against glibc 2.28, so they survive base-image bumps.
#
# Bump NODE_VERSION and both checksums together (nodejs.org/dist/vX/SHASUMS256.txt).
ARG NODE_VERSION=24.18.0
RUN set -eu \
    && case "$TARGETARCH" in \
         amd64) NODE_ARCH=x64;   NODE_SHA256=55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742;; \
         arm64) NODE_ARCH=arm64; NODE_SHA256=58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6;; \
         *) echo "unsupported arch: $TARGETARCH" >&2; exit 1;; \
       esac \
    && NODE_TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    && curl -fsSLo "/tmp/${NODE_TARBALL}" \
       "https://nodejs.org/dist/v${NODE_VERSION}/${NODE_TARBALL}" \
    && echo "${NODE_SHA256}  /tmp/${NODE_TARBALL}" | sha256sum -c - \
    && tar -xJf "/tmp/${NODE_TARBALL}" -C /usr/local --strip-components=1 --no-same-owner \
       --exclude=README.md --exclude=LICENSE --exclude=CHANGELOG.md \
    && rm "/tmp/${NODE_TARBALL}" \
    # Fail here, loudly, rather than several layers downstream.
    && node --version && npm --version

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
