/**
 * sjs-browser — Entry point
 *
 * Reads config from environment variables and starts the browser channel
 * client. Chrome is already running in the container (started by
 * entrypoint.sh, which then handed off to bootstrap.sh).
 */

import { readFileSync } from "node:fs";
import { connect, disconnect } from "./browser.js";

const serverUrl = process.env.SJS_SERVER_URL;
const apiToken = process.env.SJS_API_TOKEN;

if (!serverUrl) {
  console.error("[FATAL] SJS_SERVER_URL is required");
  console.error("  Example: wss://app.smartjobseeker.com/tunnel");
  process.exit(1);
}

if (!apiToken) {
  console.error("[FATAL] SJS_API_TOKEN is required");
  console.error("  Get your API token from the SJS dashboard");
  process.exit(1);
}

// A container has TWO independent versions, and conflating them hides a real
// problem. `src/` auto-updates from the release tarball on every boot; the
// image — Chrome, Node, the base OS, chrome-common.sh, entrypoint.sh — only
// changes when the host pulls. So a container can run current app code on a
// months-old image, and until 2026-08-09 it reported only the former.
//
// That is not hypothetical: the :latest image tag sat on v1.0.1 from
// 2026-07-11 while app code auto-updated to v1.0.4, so every instance
// reported "1.0.4" and nothing anywhere showed that the Chrome version pin
// from v1.0.2 had never arrived. Both are reported now, here and to the
// server's tunnel registry.

/**
 * The image's own build identity, baked at `docker build` time. Changes only
 * on an image pull — the bootstrap's auto-update cannot move it.
 */
const imageVersion = (process.env.SJS_BROWSER_BUILD_VERSION ?? "unknown").replace(/^v/, "");
const imageBuildDate = process.env.SJS_BROWSER_BUILD_DATE ?? "unknown";

/**
 * The running app's identity: `.build-info.json`, written into the tarball at
 * release time so it stays accurate after the bootstrap extracts a newer
 * version. Falls back to the image's own when no tarball is installed — first
 * boot, or `SJS_BROWSER_CHANNEL=disabled`, where the two are legitimately equal.
 */
function readAppBuildInfo(): { version: string; build_date: string } {
  try {
    const info = JSON.parse(readFileSync(".build-info.json", "utf-8"));
    return { version: String(info.version ?? "unknown"), build_date: String(info.build_date ?? "unknown") };
  } catch {
    return { version: imageVersion, build_date: imageBuildDate };
  }
}

const { version: buildVersion, build_date: buildDate } = readAppBuildInfo();

console.log("============================================");
console.log(" Smart Job Seeker — sjs-browser");
console.log(`  App:    ${buildVersion} (${buildDate})`);
// Printed unconditionally rather than only on a mismatch. Divergence is the
// normal state — app updates land between image pulls — so a conditional line
// would train the eye to expect its absence and make the interesting case
// (a very old image) look like the boring one.
console.log(`  Image:  ${imageVersion} (${imageBuildDate})`);
console.log(`  Server: ${serverUrl}`);
console.log("============================================");

// Periodically check the artifacts repo for a newer release. When we see
// one, exit cleanly and let `restart: unless-stopped` recreate the
// container — bootstrap.sh on the next boot will fetch + extract +
// symlink-swap to the new version. Without this, users only pick up
// updates on host-driven restarts (reboot, daemon restart, healthcheck
// failure, manual `docker compose restart`).
const watchdogChannel = process.env.SJS_BROWSER_CHANNEL ?? "stable";
const watchdogRepo = process.env.SJS_BROWSER_REPO ?? "gitaarik/sjs-browser";
const WATCHDOG_INTERVAL_MS = 6 * 60 * 60 * 1000;

if (watchdogChannel !== "disabled" && buildVersion !== "unknown") {
  // Endpoint per channel — must mirror bootstrap.sh:
  //   stable → /releases/latest      (excludes pre-releases)
  //   beta   → /releases?per_page=1  (newest release, including pre-releases)
  //   v*.*.* → /releases/tags/<tag>  (pinned tag)
  // The first two return a single release object; /releases returns an
  // array, so we unwrap it.
  const endpoint = watchdogChannel === "stable"
    ? `https://api.github.com/repos/${watchdogRepo}/releases/latest`
    : watchdogChannel === "beta"
    ? `https://api.github.com/repos/${watchdogRepo}/releases?per_page=1`
    : `https://api.github.com/repos/${watchdogRepo}/releases/tags/${watchdogChannel}`;

  const timer = setInterval(async () => {
    try {
      const r = await fetch(endpoint, {
        headers: { Accept: "application/vnd.github+json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (!r.ok) return;
      const raw = await r.json() as
        | { tag_name?: string }
        | Array<{ tag_name?: string }>;
      const latest = Array.isArray(raw) ? raw[0] : raw;
      const latestVersion = (latest?.tag_name ?? "").replace(/^v/, "");
      if (latestVersion && latestVersion !== buildVersion) {
        console.log(
          `[update] ${watchdogRepo}@${latest?.tag_name} available (running ${buildVersion}); exiting so the bootstrap can pick it up`,
        );
        disconnect();
        process.exit(0);
      }
    } catch {
      // Network failure / rate limit / etc. — try again on the next tick.
    }
  }, WATCHDOG_INTERVAL_MS);
  // Don't keep the process alive solely to run the watchdog.
  timer.unref();
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("[Main] SIGTERM received, shutting down...");
  disconnect();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("[Main] SIGINT received, shutting down...");
  disconnect();
  process.exit(0);
});

// Start the browser channel
connect({ serverUrl, apiToken, buildVersion, imageVersion });
