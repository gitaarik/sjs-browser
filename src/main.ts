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

// Build metadata: prefer .build-info.json (written into the tarball at
// release time, so it stays accurate after the bootstrap extracts a newer
// version) and fall back to the env vars baked into the image.
function readBuildInfo(): { version: string; build_date: string } {
  try {
    const info = JSON.parse(readFileSync(".build-info.json", "utf-8"));
    return { version: String(info.version ?? "unknown"), build_date: String(info.build_date ?? "unknown") };
  } catch {
    return {
      version: (process.env.SJS_BROWSER_BUILD_VERSION ?? "unknown").replace(/^v/, ""),
      build_date: process.env.SJS_BROWSER_BUILD_DATE ?? "unknown",
    };
  }
}

const { version: buildVersion, build_date: buildDate } = readBuildInfo();

console.log("============================================");
console.log(" Smart Job Seeker — sjs-browser");
console.log(`  Build: ${buildVersion} (${buildDate})`);
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
connect({ serverUrl, apiToken, buildVersion });
