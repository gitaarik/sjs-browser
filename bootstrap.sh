#!/bin/bash
# Bootstrap auto-update for sjs-browser.
#
# On container start: try to fetch the latest signed release tarball from
# https://github.com/gitaarik/sjs-browser/releases/latest, verify the
# signature against the public key baked into the image at
# /sjs-browser/release.pub, extract it under /data/app/<version>/, and
# point the /data/app/current symlink at it. Then exec the runtime from
# that directory.
#
# Failure modes are non-fatal: any error (network, signature, parse,
# extraction) keeps the existing /data/app/current pointer if one exists,
# or falls back to the source baked into the image at /sjs-browser/.
#
# This means the container is always runnable — even with no network on
# first boot, the baked fallback runs.

set -euo pipefail

CHANNEL="${SJS_BROWSER_CHANNEL:-stable}"
REPO="${SJS_BROWSER_REPO:-gitaarik/sjs-browser}"
APPS_DIR="/data/app"
PUBKEY="/sjs-browser/release.pub"
BAKED_DIR="/sjs-browser"
LOG_PREFIX="[bootstrap]"

log() { echo "$LOG_PREFIX $*"; }

# Resolve the release manifest for the configured channel.
#
# stable — GitHub's /releases/latest endpoint (excludes pre-releases).
# beta   — GitHub's /releases?per_page=1 endpoint, which returns ALL releases
#          (including pre-releases) newest-first. We unwrap the array to the
#          first element so the rest of bootstrap sees a single manifest.
# v*.*.* — pinned tag (works for both stable and beta tags).
fetch_release_json() {
  local endpoint
  case "$CHANNEL" in
    stable)
      endpoint="https://api.github.com/repos/$REPO/releases/latest"
      ;;
    beta)
      endpoint="https://api.github.com/repos/$REPO/releases?per_page=1"
      ;;
    v*.*.*)
      # Pinned tag: SJS_BROWSER_CHANNEL=v0.5.27
      endpoint="https://api.github.com/repos/$REPO/releases/tags/$CHANNEL"
      ;;
    *)
      log "WARN: unknown channel '$CHANNEL', defaulting to stable"
      endpoint="https://api.github.com/repos/$REPO/releases/latest"
      ;;
  esac
  curl -fsSL --connect-timeout 10 --max-time 30 \
    -H "Accept: application/vnd.github+json" \
    "$endpoint" \
    | jq 'if type=="array" then .[0] // empty else . end'
}

mkdir -p "$APPS_DIR"

UPDATED=false
if [ "$CHANNEL" = "disabled" ]; then
  log "auto-update disabled (SJS_BROWSER_CHANNEL=disabled), skipping fetch"
elif RELEASE_JSON=$(fetch_release_json 2>/dev/null); then
  TAG=$(echo "$RELEASE_JSON" | jq -r '.tag_name // empty')
  TARBALL_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[]? | select(.name | endswith(".tar.gz")) | .browser_download_url' | head -1)
  SIG_URL=$(echo "$RELEASE_JSON" | jq -r '.assets[]? | select(.name | endswith(".tar.gz.minisig")) | .browser_download_url' | head -1)

  if [ -z "$TAG" ] || [ -z "$TARBALL_URL" ] || [ -z "$SIG_URL" ]; then
    log "WARN: $CHANNEL release manifest missing tarball or signature asset"
  else
    VERSION="${TAG#v}"
    TARGET_DIR="$APPS_DIR/$VERSION"

    if [ -d "$TARGET_DIR" ] && [ -f "$TARGET_DIR/.build-info.json" ]; then
      log "$TAG already on disk, skipping download"
      UPDATED=true
    else
      log "downloading $TAG from $REPO..."
      TMP_DIR=$(mktemp -d)
      trap 'rm -rf "$TMP_DIR"' EXIT

      if curl -fsSL --connect-timeout 10 --max-time 120 -o "$TMP_DIR/app.tar.gz" "$TARBALL_URL" \
         && curl -fsSL --connect-timeout 10 --max-time 30 -o "$TMP_DIR/app.tar.gz.minisig" "$SIG_URL"; then
        if minisign -Vm "$TMP_DIR/app.tar.gz" -p "$PUBKEY" > /dev/null 2>&1; then
          # Extract to a .tmp dir then atomic-rename so a partially-extracted
          # archive can never become $TARGET_DIR.
          rm -rf "$TARGET_DIR.tmp"
          mkdir -p "$TARGET_DIR.tmp"
          if tar xzf "$TMP_DIR/app.tar.gz" -C "$TARGET_DIR.tmp"; then
            mv -Tf "$TARGET_DIR.tmp" "$TARGET_DIR"
            log "extracted $TAG to $TARGET_DIR"
            UPDATED=true
          else
            log "WARN: tar extract failed for $TAG"
            rm -rf "$TARGET_DIR.tmp"
          fi
        else
          log "WARN: signature verification FAILED for $TAG — refusing to install"
        fi
      else
        log "WARN: download failed for $TAG"
      fi

      rm -rf "$TMP_DIR"
      trap - EXIT
    fi

    if [ "$UPDATED" = true ] && [ -d "$TARGET_DIR" ]; then
      # Atomic symlink swap: ln -s + mv -Tf rather than ln -sfn directly
      # so a torn pointer is impossible (mv is atomic on the same fs).
      ln -sfn "$TARGET_DIR" "$APPS_DIR/current.new"
      if [ -L "$APPS_DIR/current" ]; then
        PREV=$(readlink "$APPS_DIR/current")
        if [ "$PREV" != "$TARGET_DIR" ]; then
          ln -sfn "$PREV" "$APPS_DIR/previous" 2>/dev/null || true
        fi
      fi
      mv -Tf "$APPS_DIR/current.new" "$APPS_DIR/current"
      log "current → $TARGET_DIR"
    fi
  fi
else
  log "WARN: failed to fetch release manifest from GitHub (offline?)"
fi

# Pick the runtime in priority order:
#   1. /data/app/current — installed by a previous bootstrap run
#   2. /sjs-browser      — baked into the image as a fallback
RUNTIME_DIR=""
if [ -L "$APPS_DIR/current" ] && [ -d "$APPS_DIR/current" ]; then
  RUNTIME_DIR="$APPS_DIR/current"
  log "running from $(readlink "$APPS_DIR/current")"
elif [ -d "$BAKED_DIR/src" ]; then
  RUNTIME_DIR="$BAKED_DIR"
  log "running from baked fallback ($BAKED_DIR)"
fi

if [ -z "$RUNTIME_DIR" ]; then
  echo "[bootstrap] FATAL: no runtime available (no /data/app/current and no baked src)"
  exit 1
fi

cd "$RUNTIME_DIR"
exec ./node_modules/.bin/tsx ./src/main.ts
