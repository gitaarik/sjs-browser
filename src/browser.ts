/**
 * Tunnel WebSocket client for NAS/home server deployment.
 *
 * Adapted from desktop/src/main/tunnel-client.ts.
 * Key differences from the desktop version:
 *   - No Chrome spawning — Chrome is already running in the container
 *   - No window minimize/restore — headless via Xvfb, no-ops
 *   - Config from env vars instead of JSON file
 *   - Connects to existing Chrome at 127.0.0.1:9222
 */

import WebSocket from "ws";
import http from "http";
import fs from "fs";
import { spawn } from "child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { createCdpBridge } from "./cdp-bridge.js";
import { startVncRelay, handleVncData, stopVncRelay } from "./vnc-relay.js";
import type { ClientMessage, ServerMessage } from "./protocol.js";
import { TunnelConnection } from "./tunnel-connection.js";
import { computeBezierPath } from "./stealth-path.js";

// Capabilities advertised in the startup log so a quick `docker logs` grep
// can confirm which dispatcher build is running (helps disambiguate cached
// vs. fresh image pulls).
const SUPPORTED_HANDLERS = [
  "typeText",
  "clearInput",
  "scrollWheel",
  "mouseMove",
  "screenshotRequest",
  "clickElement",
  "clickAt",
  "scrollRevealLazyContent",
  "rawMouseEvent",
  "rawScrollEvent",
  "rawKeyEvent",
  "openPage",
  "logConfig",
  "clientLog",
];
const CDP_PORT = 9222;
const CDP_WS_BASE = `ws://127.0.0.1:${CDP_PORT}`;

// Per-credential Chrome profiles. Chrome's user-data dir is owned by the
// supervisor loop in chrome-common.sh, not by this runtime. We request a
// profile switch by writing the desired dir to DESIRED_PROFILE_FILE; the
// supervisor restarts Chrome on it and echoes the live dir into
// CURRENT_PROFILE_FILE. Keeps each platform account's cookies / remember-me
// state isolated instead of sharing one profile across accounts (which made
// accounts stomp each other's session and triggered "new device" emails).
const SESSION_BASE_DIR = "/data/sessions/chrome-user-data";
const DESIRED_PROFILE_FILE = "/data/sessions/.desired-profile-dir";
const CURRENT_PROFILE_FILE = "/data/sessions/.current-profile-dir";

interface TunnelConfig {
  serverUrl: string;
  apiToken: string;
  /**
   * Real build identity (from .build-info.json or SJS_BROWSER_BUILD_VERSION),
   * sent in the auth message so the server's tunnel registry — and the
   * dashboard — can show which code revision is actually running. Required:
   * a static placeholder would be useless for verifying updates.
   */
  buildVersion: string;
}

let conn: TunnelConnection | null = null;
let currentCdpBridge: { close: () => void } | null = null;
let cdpWsUrl: string | null = null;
let versionInfo: Record<string, unknown> | null = null;

/**
 * Where the cursor sits in viewport CSS pixels after the most recent
 * click/move. Lets bezier paths start from the real last position instead
 * of teleporting to a fresh random origin between actions — the teleport
 * is a stronger bot fingerprint than a curved path alone fixes. Reset
 * between Chrome sessions, since each new browser window starts the
 * cursor at an unknown OS-cursor location anyway.
 */
let lastCursorPos: { x: number; y: number } | null = null;

// ============================================================================
// Cloud log forwarding
// ============================================================================
// Every `log()` line is also forwarded to the cloud over the WS as a
// `clientLog` message so the run dashboard can interleave cloud + tunnel
// logs. Filter rules: info/warn/error always; debug only when verbose is
// set (server pushes `logConfig` at session start). Best-effort — drops on
// disconnect; local stdout remains the source of truth.

const stepContext = new AsyncLocalStorage<{ stepId: number | undefined }>();
let logForwardingVerbose = false;
// Guards forwardLog so it never sends ahead of the `auth` message. The
// tunnel server hard-closes any connection whose first frame isn't `auth`
// (code 4003), so a stray clientLog emitted during setStatus("authenticating")
// — which fires *between* socket open and the actual auth send — would
// crash the entire connection. Flipped true in `connect()`'s onAuthOk
// wiring, reset false in onDisconnect.
let cloudLogsEnabled = false;

function redactForCloud(message: string): string {
  // Strip query strings from URLs — they often carry tokens or search terms.
  return message.replace(/(https?:\/\/[^\s?]+)\?[^\s]*/g, "$1");
}

function forwardLog(level: "debug" | "info" | "warn" | "error", message: string): void {
  if (level === "debug" && !logForwardingVerbose) return;
  if (!cloudLogsEnabled || !conn) return;
  try {
    conn.send({
      type: "clientLog",
      level,
      message: redactForCloud(message),
      ts: Date.now(),
      stepId: stepContext.getStore()?.stepId,
    });
  } catch {
    // Best-effort.
  }
}

function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [Tunnel] ${message}`);
  forwardLog("info", message);
}

/**
 * Same as log() locally, but forwards at debug-level instead of info. Used
 * for high-volume operational traces (WS envelope `→ type` / `← type`,
 * heartbeat acks) that flood the run dashboard at info level. Local file
 * keeps them full-fidelity for per-device debugging.
 */
function logTrace(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [Tunnel] ${message}`);
  forwardLog("debug", message);
}

/** Run `fn` inside an ALS context that carries the active stepId for any
 *  log() calls made during command handling. The command's `stepId` field
 *  (if present) is what cloud's `step()` was in at the moment the command
 *  was issued; propagating it back lets cloud+tunnel logs share the same
 *  step subtree in the debug view. */
function withStep<T>(stepId: number | undefined, fn: () => Promise<T>): Promise<T> {
  return stepContext.run({ stepId }, fn);
}

// Input-vs-capture gate. While an OS/CDP input command (click, type,
// scroll) is running, screenshot captures are skipped so the live-view
// poll can't compete for the X server / Chrome CDP and starve the input.
// Run 523: live-view polling at ~5/sec made every opener clickAt exceed
// its budget and time out; gating drops the overlap to at most the one
// capture already in flight when the input starts.
let inputInFlight = 0;

function withInputGate<T>(fn: () => Promise<T>): Promise<T> {
  inputInFlight++;
  return fn().finally(() => {
    inputInFlight--;
  });
}

function send(msg: ClientMessage): void {
  if (msg.type !== "cdp" && msg.type !== "cdpBinary" && msg.type !== "pong") {
    logTrace(`  -> ${msg.type}${msg.type === "sessionError" ? ` (${(msg as { error: string }).error})` : ""}`);
  }
  conn?.send(msg);
}

// =============================================================================
// Chrome interaction helpers
// =============================================================================

/**
 * Look up a page target ID from Chrome's /json endpoint.
 */
/**
 * One HTTP roundtrip → both pageId AND webSocketDebuggerUrl. Used by the
 * persistent page CDP WS setup below; previously each command went through
 * two `/json` fetches (one to find the page id, another to look up the WS
 * URL) on top of opening a fresh WebSocket — pure duplicate work.
 */
async function fetchPageTarget(): Promise<{ pageId: string; webSocketDebuggerUrl: string; url?: string }> {
  const targets = await new Promise<
    Array<{ id: string; type: string; webSocketDebuggerUrl?: string; url?: string }>
  >((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
      let data = "";
      res.on("data", (chunk: string) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from /json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout fetching CDP targets")); });
  });

  const page = targets.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("No page targets with WebSocket URL found");
  }
  return { pageId: page.id, webSocketDebuggerUrl: page.webSocketDebuggerUrl, url: page.url };
}


/**
 * Send CDP commands on a short-lived browser-level WebSocket.
 */
async function cdpBrowserCall(
  pageId: string,
  messages: { method: string; params?: Record<string, unknown> }[],
): Promise<unknown> {
  if (!cdpWsUrl) throw new Error("No CDP WebSocket URL");
  return new Promise((resolve, reject) => {
    const cdpWs = new WebSocket(cdpWsUrl!);
    const timeout = setTimeout(() => { cdpWs.close(); reject(new Error("Timeout")); }, 3000);
    let step = 0;

    cdpWs.on("open", () => {
      cdpWs.send(JSON.stringify({ id: 1, ...messages[0], params: { targetId: pageId, ...messages[0].params } }));
    });

    cdpWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id !== step + 1) return;
        if (msg.error) {
          clearTimeout(timeout); cdpWs.close();
          reject(new Error(`${messages[step].method}: ${msg.error.message}`));
          return;
        }
        step++;
        if (step >= messages.length) {
          clearTimeout(timeout); cdpWs.close();
          resolve(msg.result);
        } else {
          const params = { ...messages[step].params };
          if (msg.result?.windowId !== undefined) params.windowId = msg.result.windowId;
          cdpWs.send(JSON.stringify({ id: step + 1, method: messages[step].method, params }));
        }
      } catch (err) {
        log(`cdpBrowserCall: JSON parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    cdpWs.on("error", (err) => { clearTimeout(timeout); reject(err); });
  });
}

type DirectPageCdpAttempt =
  | { ok: true }
  | { ok: false; phase: "connect" | "callback"; error: Error };

/**
 * One connect-and-run attempt against a specific page target. Resolves
 * (never rejects) with a tagged result so the caller can decide whether the
 * failure is retryable:
 *   - `phase: "connect"` — the websocket never fired `open` within
 *     connectTimeoutMs. The target was likely torn down by an in-flight
 *     navigation; a refetch may find a live one.
 *   - `phase: "callback"` — we connected but the CDP work stalled or threw.
 *     Retrying against a new socket won't help.
 */
async function attemptDirectPageCdp(
  label: string,
  connectTimeoutMs: number,
  overallTimeoutMs: number,
  target: { pageId: string; webSocketDebuggerUrl: string; url?: string },
  fn: (pageWs: WebSocket, nextId: () => number) => Promise<void>,
): Promise<DirectPageCdpAttempt> {
  const targetLabel = target.url ?? target.pageId;
  return new Promise<DirectPageCdpAttempt>((resolve) => {
    let phase: "connect" | "callback" = "connect";
    let settled = false;
    let connectTimer: ReturnType<typeof setTimeout> | undefined;
    let overallTimer: ReturnType<typeof setTimeout> | undefined;
    const pageWs = new WebSocket(target.webSocketDebuggerUrl);
    let msgId = 1;
    const nextId = () => msgId++;

    const settle = (result: DirectPageCdpAttempt) => {
      if (settled) return;
      settled = true;
      clearTimeout(connectTimer);
      clearTimeout(overallTimer);
      pageWs.close();
      resolve(result);
    };

    // Short timer covering the connect phase only: a healthy local page target
    // opens its WS in <1ms, so a stall here is the retryable stale-target case.
    connectTimer = setTimeout(() => {
      if (phase !== "connect") return;
      settle({
        ok: false,
        phase: "connect",
        // "<label>: …" shape so isAutomationErrorMessage's anchored patterns
        // (/^clickAt:/, /^clickElement:/) classify it as a tooling error.
        error: new Error(`${label}: timeout — websocket never opened (target ${targetLabel})`),
      });
    }, connectTimeoutMs);

    // Overall budget for the whole attempt (connect + callback).
    overallTimer = setTimeout(() => {
      settle({
        ok: false,
        phase,
        error: new Error(
          `${label}: timeout — ${
            phase === "connect" ? "websocket never opened" : "callback stalled"
          } (target ${targetLabel})`,
        ),
      });
    }, overallTimeoutMs);

    pageWs.on("open", async () => {
      phase = "callback";
      clearTimeout(connectTimer);
      try {
        await fn(pageWs, nextId);
        settle({ ok: true });
      } catch (err) {
        settle({
          ok: false,
          phase: "callback",
          error: err instanceof Error ? err : new Error(String(err)),
        });
      }
    });

    pageWs.on("error", (err) => {
      settle({
        ok: false,
        phase,
        error: err instanceof Error ? err : new Error(String(err)),
      });
    });
  });
}

/**
 * Open a fresh CDP WebSocket to the active page target, run a callback,
 * and close it. Per-call (not persistent) — an earlier attempt at a
 * shared persistent WS hit Proxy timeouts during login flows where the
 * page navigates across origins and the WS goes stale without firing a
 * close event; the readyState check still saw "OPEN" while operations
 * hung until the parent's 10s ack timer.
 *
 * Even a fresh per-call WS can hang: if the page navigates *while we are
 * connecting* (Upwork's search submit fires an SPA nav that tears down the
 * page target mid-click — run 1115), the socket never fires `open` and stalls
 * until the timeout, surfacing as an opaque "<label> timeout" that hides which
 * phase failed. So we split the budget: the connect phase gets its own short
 * timeout, and if it stalls we refetch the (now-current) target and retry once.
 * A stall or throw *after* connect is not retryable. The error message names
 * the failed phase and target for the preview debug tool.
 */
async function withDirectPageCdp(
  label: string,
  timeoutMs: number,
  fn: (pageWs: WebSocket, nextId: () => number) => Promise<void>,
): Promise<void> {
  const CONNECT_TIMEOUT_MS = Math.min(3000, timeoutMs);
  const started = Date.now();
  const maxAttempts = 2;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new Error(
        `${label}: timeout — budget exhausted after ${attempt - 1} attempt(s)`,
      );
    }
    const target = await fetchPageTarget();
    const result = await attemptDirectPageCdp(
      label,
      Math.min(CONNECT_TIMEOUT_MS, remaining),
      remaining,
      target,
      fn,
    );
    if (result.ok) return;
    if (result.phase === "connect" && attempt < maxAttempts) {
      log(
        `${label}: websocket never opened for target ${
          target.url ?? target.pageId
        } within ${Math.min(CONNECT_TIMEOUT_MS, remaining)}ms — target likely churned by navigation, refetching and retrying`,
      );
      continue;
    }
    throw result.error;
  }
  // Loop always returns on success or throws above; this satisfies the
  // compiler's control-flow analysis.
  throw new Error(`${label}: timeout`);
}

// =============================================================================
// Input handling (typeText, scrollWheel, mouseMove, clickElement, etc.)
// =============================================================================

/**
 * Type a single character via xdotool — produces real X11 keypress events,
 * indistinguishable from manual keyboard input (or VNC keystrokes). CDP
 * Input.dispatchKeyEvent is fingerprintable by anti-bot scripts (Upwork,
 * for one); xdotool is not.
 */
function typeCharViaXdotool(ch: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("xdotool", ["type", "--delay", "0", "--", ch], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", (err) => reject(err));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`xdotool exit ${code}: ${stderr.trim()}`));
    });
  });
}

/**
 * Clear the focused input via xdotool select-all + delete (real X11 events).
 * Linux-only — this image is Ubuntu. Falls back to CDP if xdotool fails.
 */
async function handleClearInput(): Promise<void> {
  if (process.platform === "linux") {
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn("xdotool", ["key", "ctrl+a", "BackSpace"], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        proc.stderr?.on("data", (d) => { stderr += d.toString(); });
        proc.on("error", reject);
        proc.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`xdotool exit ${code}: ${stderr.trim()}`));
        });
      });
      log("Cleared input via xdotool");
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`xdotool clearInput failed (${msg}), falling back to CDP`);
    }
  }

  await withDirectPageCdp("clearInput", 30_000, async (pageWs, nextId) => {
    const sendKey = (eventType: string, key: string, code: string, modifiers = 0) => {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: eventType, key, code, modifiers },
      }));
    };
    sendKey("keyDown", "a", "KeyA", 2);
    sendKey("keyUp", "a", "KeyA", 2);
    await new Promise((r) => setTimeout(r, 50));
    sendKey("keyDown", "Backspace", "Backspace");
    sendKey("keyUp", "Backspace", "Backspace");
  });
  log("Cleared input via CDP");
}

function pressKeyViaXdotool(key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("xdotool", ["key", key], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`xdotool exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function handleTypeText(text: string, charDelayMs: number, submitAfter = false): Promise<void> {
  // Linux container — prefer xdotool for real X11 keypress events
  if (process.platform === "linux") {
    try {
      for (const ch of text) {
        await typeCharViaXdotool(ch);
        if (charDelayMs > 0) {
          const variance = charDelayMs * 0.4;
          const delay = charDelayMs + (Math.random() * 2 - 1) * variance;
          await new Promise((r) => setTimeout(r, Math.max(8, delay)));
        }
      }
      if (submitAfter) {
        if (text) await new Promise((r) => setTimeout(r, 80 + Math.random() * 60));
        await pressKeyViaXdotool("Return");
      }
      log(`Typed ${text.length} chars via xdotool${submitAfter ? " + Enter" : ""} (${charDelayMs}ms/char)`);
      return;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`xdotool typing failed (${msg}), falling back to CDP`);
    }
  }

  await withDirectPageCdp("typeText", 30_000, async (pageWs, nextId) => {
    for (const char of text) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", text: char, key: char, code: "" },
      }));
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: char, code: "" },
      }));

      if (charDelayMs > 0) {
        const variance = charDelayMs * 0.4;
        const delay = charDelayMs + (Math.random() * 2 - 1) * variance;
        await new Promise((r) => setTimeout(r, Math.max(8, delay)));
      }
    }
    if (submitAfter) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: "keyDown", key: "Enter", code: "Enter", text: "\r" },
      }));
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchKeyEvent",
        params: { type: "keyUp", key: "Enter", code: "Enter" },
      }));
    }
  });
  log(`Typed ${text.length} chars locally via CDP${submitAfter ? " + Enter" : ""} (${charDelayMs}ms/char)`);
}

async function handleScrollWheel(
  mouseX: number,
  mouseY: number,
  steps: { deltaY: number; delayMs: number }[],
): Promise<void> {
  await withDirectPageCdp("scrollWheel", 30_000, async (pageWs, nextId) => {
    pageWs.send(JSON.stringify({
      id: nextId(),
      method: "Input.dispatchMouseEvent",
      params: { type: "mouseMoved", x: mouseX, y: mouseY },
    }));

    for (const step of steps) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseWheel", x: mouseX, y: mouseY, deltaX: 0, deltaY: step.deltaY },
      }));
      if (step.delayMs > 0) {
        await new Promise((r) => setTimeout(r, step.delayMs));
      }
    }
  });
  log(`Scrolled ${steps.length} steps locally`);
}

async function handleMouseMove(
  steps: { x: number; y: number; delayMs: number }[],
): Promise<void> {
  await withDirectPageCdp("mouseMove", 30_000, async (pageWs, nextId) => {
    for (const step of steps) {
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: step.x, y: step.y },
      }));
      if (step.delayMs > 0) {
        await new Promise((r) => setTimeout(r, step.delayMs));
      }
    }
  });
  if (steps.length > 0) {
    const end = steps[steps.length - 1];
    lastCursorPos = { x: end.x, y: end.y };
  }
  log(`Moved mouse locally (${steps.length} points)`);
}

function quadToBox(quad: number[]): { x: number; y: number; width: number; height: number } {
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  return { x: minX, y: minY, width: Math.max(...xs) - minX, height: Math.max(...ys) - minY };
}

const MODIFIER_MAP: Record<string, { key: string; code: string; keyCode: number; bit: number }> = {
  Control: { key: "Control", code: "ControlLeft", keyCode: 17, bit: 2 },
  Shift:   { key: "Shift",   code: "ShiftLeft",   keyCode: 16, bit: 8 },
  Alt:     { key: "Alt",     code: "AltLeft",      keyCode: 18, bit: 1 },
  Meta:    { key: "Meta",    code: "MetaLeft",     keyCode: 91, bit: 4 },
};

// Modifier names → xdotool key names (different vocabulary from CDP's MODIFIER_MAP).
const XDOTOOL_MODIFIER_MAP: Record<string, string> = {
  Control: "ctrl",
  Shift:   "shift",
  Alt:     "alt",
  Meta:    "super",
};

// xdotool button numbers: 1=left, 2=middle, 3=right.
const XDOTOOL_BUTTON_MAP: Record<"left" | "middle" | "right", number> = {
  left: 1,
  middle: 2,
  right: 3,
};

/**
 * Translate page (CSS-pixel, viewport-relative) coordinates to absolute
 * screen coordinates of the Chrome window. Used to point xdotool at the
 * right pixel.
 *
 * The Chrome window contains the browser chrome (toolbar + tabs) above
 * the page viewport; chromeBarHeight = window.height − viewport.height
 * accounts for that. Inside the docker tunnel, the Chrome window runs
 * full-screen on a virtual Xvfb display with devicePixelRatio=1, so CSS
 * pixels and screen pixels are 1:1.
 */
function pageToScreen(
  pageX: number,
  pageY: number,
  win: { left: number; top: number; height: number },
  viewportHeightCss: number,
): { x: number; y: number } {
  const chromeBarHeight = win.height - viewportHeightCss;
  return {
    x: Math.round(win.left + pageX),
    y: Math.round(win.top + chromeBarHeight + pageY),
  };
}

/**
 * Perform an OS-level click via xdotool: real X11 mouse events that move
 * the OS keyboard focus to whatever the cursor lands on. Unlike CDP
 * Input.dispatchMouseEvent, this updates the browser window's OS focus —
 * essential before xdotool typing, which sends keystrokes to whatever the
 * OS thinks is focused (otherwise typing leaks into the omnibox after a
 * page navigation). Linux-only; called from the docker container which
 * always has xdotool + Xvfb available.
 *
 * Movement follows a Bézier path with subtle tremor for stealth. All
 * mouse events plus modifier keydowns/keyups are issued in a single
 * xdotool invocation to avoid per-step process-spawn overhead.
 */
function clickViaXdotool(
  path: { x: number; y: number }[],
  button: "left" | "middle" | "right",
  modifiers: string[] = [],
): Promise<void> {
  const buttonNum = XDOTOOL_BUTTON_MAP[button];
  const xdotoolMods = modifiers
    .map((m) => XDOTOOL_MODIFIER_MAP[m])
    .filter((m): m is string => Boolean(m));

  // The trailing `click` fires at the cursor's current position. Without
  // --sync, xdotool returns from each mousemove before the X server has
  // actually moved the cursor, so the click can land on an earlier point
  // in the path. We --sync only the final move (the cheap fast intermediate
  // moves stay async — they just paint a trail).
  const args: string[] = [];
  for (const mod of xdotoolMods) args.push("keydown", mod);
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const isLast = i === path.length - 1;
    if (isLast) args.push("mousemove", "--sync");
    else args.push("mousemove");
    args.push(String(Math.round(p.x)), String(Math.round(p.y)));
  }
  args.push("click", String(buttonNum));
  for (const mod of xdotoolMods.slice().reverse()) args.push("keyup", mod);

  return new Promise((resolve, reject) => {
    const proc = spawn("xdotool", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr?.on("data", (d) => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`xdotool click exit ${code}: ${stderr.trim()}`));
    });
  });
}

async function handleClickElement(
  requestId: string,
  selector: string,
  timeout: number,
  modifiers?: string[],
  button: "left" | "middle" | "right" = "left",
): Promise<void> {
  // Snapshot page targets before click to detect new tabs
  let targetsBefore: string[] = [];
  try {
    const targets: { id: string; type: string }[] = await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
        let data = "";
        res.on("data", (chunk: string) => (data += chunk));
        res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
      });
      req.on("error", () => resolve([]));
      req.setTimeout(1000, () => { req.destroy(); resolve([]); });
    });
    targetsBefore = targets.filter(t => t.type === "page").map(t => t.id);
  } catch { /* ignore */ }

  await withDirectPageCdp("clickElement", timeout + 5000, async (pageWs, nextId) => {
    const cdpCall = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          pageWs.removeListener("message", onMsg);
          reject(new Error(`${method} timeout`));
        }, timeout);

        const onMsg = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.id === id) {
              clearTimeout(timer);
              pageWs.removeListener("message", onMsg);
              if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
              else resolve((msg.result || {}) as T);
            }
          } catch (err) {
            log(`clickElement cdpCall parse error: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        pageWs.on("message", onMsg);
        pageWs.send(JSON.stringify({ id, method, params }));
      });
    };

    const { root } = await cdpCall<{ root: { nodeId: number } }>("DOM.getDocument", { depth: 0 });
    const { nodeId } = await cdpCall<{ nodeId: number }>("DOM.querySelector", {
      nodeId: root.nodeId,
      selector,
    });
    if (!nodeId) throw new Error(`Element not found: ${selector}`);

    await cdpCall("DOM.scrollIntoViewIfNeeded", { nodeId });
    await new Promise((r) => setTimeout(r, 100));

    const { model } = await cdpCall<{ model: { content: number[] } }>("DOM.getBoxModel", { nodeId });
    if (!model?.content || model.content.length < 8) {
      throw new Error(`Cannot get bounding box for: ${selector}`);
    }
    const box = quadToBox(model.content);

    const paddingX = box.width * 0.1;
    const paddingY = box.height * 0.1;
    const targetX = box.x + paddingX + Math.random() * (box.width - 2 * paddingX);
    const targetY = box.y + paddingY + Math.random() * (box.height - 2 * paddingY);

    // Start the bezier from the cursor's real last position so the path
    // chains continuously between actions — a teleport-then-curve looks
    // unmistakably scripted even when the curve itself is natural. Fall
    // back to a random viewport point only on the first action of a
    // session, when we don't yet know where the cursor sits.
    const fromX = lastCursorPos?.x ?? 1280 * (0.2 + Math.random() * 0.6);
    const fromY = lastCursorPos?.y ?? 800 * (0.2 + Math.random() * 0.6);
    const pagePath = computeBezierPath(fromX, fromY, targetX, targetY);
    // Record eagerly: even if the click below throws, the cursor still
    // moved during the bezier path, so the next action should chain from
    // here rather than re-teleport.
    lastCursorPos = { x: targetX, y: targetY };

    // Arm a one-shot click listener on the target element in an isolated
    // world. Resolves when the real DOM click event lands — direct positive
    // signal that the OS mouse event reached the right element. Isolated
    // world keeps the listener and globals invisible to page scripts; the
    // click event itself stays isTrusted=true since it originates from
    // xdotool's real X11 input. See discussion in tracking notes.
    let listenerCtxId: number | null = null;
    try {
      const { frameTree } = await cdpCall<{ frameTree: { frame: { id: string } } }>(
        "Page.getFrameTree", {},
      );
      const { executionContextId } = await cdpCall<{ executionContextId: number }>(
        "Page.createIsolatedWorld",
        { frameId: frameTree.frame.id, worldName: "sjs-click-monitor" },
      );
      const { object } = await cdpCall<{ object: { objectId?: string } }>(
        "DOM.resolveNode", { nodeId, executionContextId },
      );
      if (object.objectId) {
        await cdpCall("Runtime.callFunctionOn", {
          objectId: object.objectId,
          functionDeclaration: `function() {
            const el = this;
            globalThis.__sjsClickPromise = new Promise((resolve) => {
              const onClick = (e) => resolve(e.type);
              el.addEventListener('click', onClick, { once: true, capture: true });
              el.addEventListener('auxclick', onClick, { once: true, capture: true });
              addEventListener('pagehide', () => resolve('pagehide'), { once: true });
            });
          }`,
          returnByValue: true,
        });
        listenerCtxId = executionContextId;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`Click listener arm failed (${msg}), proceeding without confirmation`);
    }

    // Linux: route the click through xdotool so the browser window
    // receives a real OS-level mouse event. CDP Input.dispatchMouseEvent
    // only updates the renderer; OS keyboard focus stays wherever it was
    // (often the omnibox after a navigation), and the subsequent xdotool
    // typing then leaks into the address bar. See run 555.
    let clickPerformed = false;
    if (process.platform === "linux") {
      try {
        const { bounds } = await cdpCall<{
          bounds: { left?: number; top?: number; width: number; height: number };
        }>("Browser.getWindowForTarget", {});
        const layoutMetrics = await cdpCall<{
          cssLayoutViewport: { clientHeight: number };
        }>("Page.getLayoutMetrics", {});

        const win = {
          left: bounds.left ?? 0,
          top: bounds.top ?? 0,
          height: bounds.height,
        };
        const viewportH = layoutMetrics.cssLayoutViewport.clientHeight;

        const screenPath = pagePath.map((p) =>
          pageToScreen(p.x, p.y, win, viewportH)
        );

        await clickViaXdotool(screenPath, button, modifiers ?? []);
        clickPerformed = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log(`xdotool click failed (${msg}), falling back to CDP`);
      }
    }

    // CDP fallback (non-Linux, or xdotool failure). DOM focus updates but
    // OS keyboard focus may stay on the omnibox — see comment above.
    if (!clickPerformed) {
      for (const point of pagePath) {
        pageWs.send(JSON.stringify({
          id: nextId(),
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseMoved", x: point.x, y: point.y },
        }));
        if (point.delayMs > 0) {
          await new Promise((r) => setTimeout(r, point.delayMs));
        }
      }

      await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));

      const modifierBitmask = (modifiers || []).reduce((mask, mod) => {
        const info = MODIFIER_MAP[mod];
        if (info) {
          pageWs.send(JSON.stringify({
            id: nextId(),
            method: "Input.dispatchKeyEvent",
            params: { type: "rawKeyDown", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode, modifiers: mask | info.bit },
          }));
          return mask | info.bit;
        }
        return mask;
      }, 0);

      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mousePressed", x: targetX, y: targetY, button, clickCount: 1, modifiers: modifierBitmask },
      }));
      await new Promise((r) => setTimeout(r, 30 + Math.random() * 50));
      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseReleased", x: targetX, y: targetY, button, clickCount: 1, modifiers: modifierBitmask },
      }));

      for (const mod of (modifiers || []).slice().reverse()) {
        const info = MODIFIER_MAP[mod];
        if (info) {
          pageWs.send(JSON.stringify({
            id: nextId(),
            method: "Input.dispatchKeyEvent",
            params: { type: "keyUp", key: info.key, code: info.code, windowsVirtualKeyCode: info.keyCode },
          }));
        }
      }
    }

    // Await the click listener armed earlier — this is the direct positive
    // signal that the OS click reached the right element. If the listener
    // times out, the click missed (wrong target, occluded, off-screen). If
    // the JS context was destroyed, the page navigated — also success.
    if (listenerCtxId !== null) {
      try {
        const result = await cdpCall<{ result: { value: string } }>(
          "Runtime.callFunctionOn",
          {
            executionContextId: listenerCtxId,
            functionDeclaration: `function() {
              return Promise.race([
                globalThis.__sjsClickPromise || Promise.resolve('not-armed'),
                new Promise((r) => setTimeout(() => r('event-timeout'), 3000)),
              ]);
            }`,
            awaitPromise: true,
            returnByValue: true,
          },
        );
        const outcome = String(result.result?.value ?? "unknown");
        if (outcome === "event-timeout") {
          throw new Error(
            `Click on "${selector}" did not produce a DOM click event within 3s — likely missed the target`,
          );
        }
        log(`Click confirmed on ${selector} (${outcome})`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Execution context destroyed = page navigated = click landed.
        if (/context|destroyed|Cannot find/i.test(msg) && !msg.includes("did not produce")) {
          log(`Click on ${selector} caused navigation (context destroyed)`);
        } else {
          throw err;
        }
      }
    }
  });

  // Check if a new tab appeared after the click
  let newTabOpened = false;
  if (targetsBefore.length > 0) {
    await new Promise((r) => setTimeout(r, 300));
    try {
      const targets: { id: string; type: string }[] = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
          let data = "";
          res.on("data", (chunk: string) => (data += chunk));
          res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve([]); } });
        });
        req.on("error", () => resolve([]));
        req.setTimeout(1000, () => { req.destroy(); resolve([]); });
      });
      const pagesAfter = targets.filter(t => t.type === "page").map(t => t.id);
      newTabOpened = pagesAfter.some(id => !targetsBefore.includes(id));
    } catch { /* ignore */ }
  }

  send({ type: "clickElementResponse", requestId, success: true, newTabOpened });
  log(`Clicked element locally: ${selector}${modifiers?.length ? ` [${modifiers.join("+")}]` : ""}${newTabOpened ? " (new tab opened)" : ""}`);
}

/**
 * Click at viewport-relative CSS-pixel coordinates. The cloud-side already
 * has a Playwright element handle and computed the target box — we just
 * translate page→screen coords and drive xdotool. No DOM.querySelector,
 * no DOM.getBoxModel, no risk of stale-selector misses on shadow DOM,
 * iframes, or dynamic IDs.
 *
 * Linux-only: xdotool is required. The whole point of this entrypoint is
 * to move OS keyboard focus so subsequent xdotool typing doesn't leak into
 * the omnibox; a CDP fallback would defeat that purpose, so we error out
 * instead and let the caller decide how to recover.
 */
async function handleClickAt(
  requestId: string,
  pageX: number,
  pageY: number,
  timeout: number,
  modifiers?: string[],
  button: "left" | "middle" | "right" = "left",
): Promise<void> {
  if (process.platform !== "linux") {
    throw new Error("clickAt requires Linux/xdotool (NAS mode is Linux-only)");
  }

  await withDirectPageCdp("clickAt", timeout + 5000, async (pageWs, nextId) => {
    const cdpCall = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          pageWs.removeListener("message", onMsg);
          reject(new Error(`${method} timeout`));
        }, timeout);

        const onMsg = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.id === id) {
              clearTimeout(timer);
              pageWs.removeListener("message", onMsg);
              if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
              else resolve((msg.result || {}) as T);
            }
          } catch (err) {
            log(`clickAt cdpCall parse error: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        pageWs.on("message", onMsg);
        pageWs.send(JSON.stringify({ id, method, params }));
      });
    };

    const { bounds } = await cdpCall<{
      bounds: { left?: number; top?: number; width: number; height: number };
    }>("Browser.getWindowForTarget", {});
    const layoutMetrics = await cdpCall<{
      cssLayoutViewport: { clientHeight: number; clientWidth: number };
    }>("Page.getLayoutMetrics", {});

    const win = {
      left: bounds.left ?? 0,
      top: bounds.top ?? 0,
      height: bounds.height,
    };
    const viewportH = layoutMetrics.cssLayoutViewport.clientHeight;
    const viewportW = layoutMetrics.cssLayoutViewport.clientWidth;

    // Bezier path from the cursor's real last position so the path chains
    // between actions; fall back to a random in-viewport point only on the
    // first action of a session. The "from" is page-relative (pre-translation)
    // so the curve is computed in the same coord space as the target. See
    // handleClickElement for the full rationale.
    const fromX = lastCursorPos?.x ?? viewportW * (0.2 + Math.random() * 0.6);
    const fromY = lastCursorPos?.y ?? viewportH * (0.2 + Math.random() * 0.6);
    const pagePath = computeBezierPath(fromX, fromY, pageX, pageY);
    lastCursorPos = { x: pageX, y: pageY };

    const screenPath = pagePath.map((p) => pageToScreen(p.x, p.y, win, viewportH));

    await clickViaXdotool(screenPath, button, modifiers ?? []);
  });

  send({ type: "clickAtResponse", requestId, success: true });
  log(`Clicked at (${Math.round(pageX)}, ${Math.round(pageY)}) via xdotool${modifiers?.length ? ` [${modifiers.join("+")}]` : ""}`);
}

async function handleScreenshotRequest(
  requestId: string,
  format: string,
  quality: number,
  viaX11: boolean = false,
): Promise<void> {
  if (inputInFlight > 0) {
    // An input command is running — skip the capture so we don't compete
    // for the X server / CDP. Live-view treats a null frame as "keep the
    // last image"; the next poll catches up once the input completes.
    send({ type: "screenshotResponse", requestId, data: null });
    return;
  }

  if (viaX11) {
    await captureViaX11(requestId, format);
    return;
  }

  if (!cdpWsUrl) {
    send({ type: "screenshotResponse", requestId, data: null });
    return;
  }

  await new Promise<void>((resolve) => {
    const browserWs = new WebSocket(cdpWsUrl!);
    const timeout = setTimeout(() => {
      send({ type: "screenshotResponse", requestId, data: null });
      browserWs.close();
      resolve();
    }, 5000);
    let msgId = 1;
    let cdpSessionId = "";

    browserWs.on("open", () => {
      browserWs.send(JSON.stringify({ id: msgId++, method: "Target.getTargets" }));
    });

    browserWs.on("message", (raw: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.id === 1 && msg.result?.targetInfos) {
          const pages = (msg.result.targetInfos as { targetId: string; type: string; url: string }[])
            .filter((t) => t.type === "page" && !t.url.startsWith("chrome://") && t.url !== "about:blank");
          const target = pages[pages.length - 1] || pages[0];
          if (!target) {
            clearTimeout(timeout);
            send({ type: "screenshotResponse", requestId, data: null });
            browserWs.close();
            resolve();
            return;
          }
          browserWs.send(JSON.stringify({
            id: msgId++,
            method: "Target.attachToTarget",
            params: { targetId: target.targetId, flatten: true },
          }));
        }

        if (msg.id === 2 && msg.result?.sessionId) {
          cdpSessionId = msg.result.sessionId;
          browserWs.send(JSON.stringify({
            id: msgId++,
            method: "Page.captureScreenshot",
            sessionId: cdpSessionId,
            params: { format, quality },
          }));
        }

        if (msg.id === 3) {
          const data = msg.result?.data || null;
          send({ type: "screenshotResponse", requestId, data });
          if (cdpSessionId) {
            browserWs.send(JSON.stringify({
              id: msgId++,
              method: "Target.detachFromTarget",
              params: { sessionId: cdpSessionId },
            }));
          }
          clearTimeout(timeout);
          browserWs.close();
          resolve();
        }
      } catch (err) {
        log(`Screenshot CDP parse error: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    browserWs.on("error", () => {
      clearTimeout(timeout);
      send({ type: "screenshotResponse", requestId, data: null });
      resolve();
    });
  });
}

/**
 * Capture the X11 display via `scrot` — bypasses Chrome's CDP queue
 * entirely. Lets debug screenshots fire without competing with clickAt's
 * own CDP calls (Browser.getWindowForTarget, Page.getLayoutMetrics).
 *
 * Output is the whole X display, which on Xvfb-based Chrome is just
 * Chrome at full size. Marker overlays injected via page.evaluate before
 * this call are rendered into the X framebuffer by Chrome's compositor
 * and therefore appear in the capture.
 *
 * `format` is honored: png by default, jpeg via -t (scrot's --thumbnail
 * isn't quite the same, but scrot 1.x reads -F filename.jpg as a format
 * hint and ImageMagick conversion isn't worth the dependency here).
 */
async function captureViaX11(requestId: string, format: string): Promise<void> {
  const ext = format === "jpeg" ? "jpg" : "png";
  const outPath = `/tmp/sjs-x11-${requestId}.${ext}`;
  try {
    await new Promise<void>((resolve, reject) => {
      // -z: no compression for png (slightly faster); -q: jpeg quality
      // (ignored for png). --silent: don't beep / print to stdout.
      const args = format === "jpeg"
        ? ["--silent", "-q", "85", outPath]
        : ["--silent", "-z", outPath];
      const proc = spawn("scrot", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      proc.stderr?.on("data", (d) => { stderr += d.toString(); });
      proc.on("error", reject);
      proc.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`scrot exit ${code}: ${stderr.trim()}`));
      });
    });

    const buf = await fs.promises.readFile(outPath);
    const data = buf.toString("base64");
    send({ type: "screenshotResponse", requestId, data });
  } catch (err) {
    log(`captureViaX11 failed: ${err instanceof Error ? err.message : String(err)}`);
    send({ type: "screenshotResponse", requestId, data: null });
  } finally {
    fs.promises.unlink(outPath).catch(() => {});
  }
}

// =============================================================================
// Raw input forwarding (interactive browser control)
// =============================================================================

// Cached CDP WebSocket for raw input — avoid opening a new connection per
// event during interactive VNC mouse/key forwarding. Kept separate from
// the per-call WS used by withDirectPageCdp (commands like clickAt /
// typeText); raw input doesn't span page navigations so the staleness
// problem that broke the persistent shared WS doesn't apply here.
let rawInputCdpWs: WebSocket | null = null;
let rawInputMsgId = 1;
let rawInputIdleTimer: ReturnType<typeof setTimeout> | null = null;
const RAW_INPUT_IDLE_MS = 30_000;

function resetRawInputIdleTimer() {
  if (rawInputIdleTimer) clearTimeout(rawInputIdleTimer);
  rawInputIdleTimer = setTimeout(() => {
    if (rawInputCdpWs && rawInputCdpWs.readyState === WebSocket.OPEN) {
      rawInputCdpWs.close();
    }
    rawInputCdpWs = null;
    rawInputMsgId = 1;
  }, RAW_INPUT_IDLE_MS);
}

async function getRawInputCdpWs(): Promise<WebSocket> {
  if (rawInputCdpWs && rawInputCdpWs.readyState === WebSocket.OPEN) {
    resetRawInputIdleTimer();
    return rawInputCdpWs;
  }

  const { webSocketDebuggerUrl } = await fetchPageTarget();

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(webSocketDebuggerUrl);
    const timeout = setTimeout(() => { ws.close(); reject(new Error("CDP connect timeout")); }, 5_000);
    ws.on("open", () => {
      clearTimeout(timeout);
      rawInputCdpWs = ws;
      rawInputMsgId = 1;
      resetRawInputIdleTimer();
      resolve(ws);
    });
    ws.on("error", (err) => { clearTimeout(timeout); reject(err); });
    ws.on("close", () => {
      if (rawInputCdpWs === ws) rawInputCdpWs = null;
    });
  });
}

function sendCdpInput(method: string, params: Record<string, unknown>) {
  getRawInputCdpWs().then((ws) => {
    ws.send(JSON.stringify({ id: rawInputMsgId++, method, params }));
  }).catch((err) => {
    log(`ERROR: sendCdpInput(${method}) failed: ${err instanceof Error ? err.message : String(err)}`);
  });
}

const CDP_BUTTON_MAP: Record<string, string> = { left: "left", right: "right", middle: "middle" };

async function handleRawMouseEvent(msg: {
  x: number; y: number;
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved";
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: number;
}): Promise<void> {
  const params: Record<string, unknown> = { type: msg.eventType, x: msg.x, y: msg.y };
  if (msg.button) params.button = CDP_BUTTON_MAP[msg.button] || "left";
  if (msg.clickCount) params.clickCount = msg.clickCount;
  if (msg.modifiers) params.modifiers = msg.modifiers;
  sendCdpInput("Input.dispatchMouseEvent", params);
}

async function handleRawScrollEvent(msg: {
  x: number; y: number; deltaX: number; deltaY: number;
}): Promise<void> {
  sendCdpInput("Input.dispatchMouseEvent", {
    type: "mouseWheel", x: msg.x, y: msg.y, deltaX: msg.deltaX, deltaY: msg.deltaY,
  });
}

async function handleRawKeyEvent(msg: {
  eventType: "keyDown" | "keyUp"; key: string; code: string;
  text?: string; modifiers?: number;
}): Promise<void> {
  const params: Record<string, unknown> = { type: msg.eventType, key: msg.key, code: msg.code };
  if (msg.text) params.text = msg.text;
  if (msg.modifiers) params.modifiers = msg.modifiers;
  sendCdpInput("Input.dispatchKeyEvent", params);
}

/**
 * Manual-browser entrypoint: open a new tab in the already-running Chrome
 * and navigate to `url`. Independent of any scrape session — works while
 * a scrape is in progress (it just adds a tab next to the scraper's tab)
 * AND between scrapes (no CDP bridge required).
 *
 * Routes via the browser-level CDP `Target.createTarget`, which both
 * creates and activates the new target. We don't touch the scraper's
 * existing CDP bridge or page sessions, so the running scrape is
 * unaffected.
 */
async function handleOpenPage(
  requestId: string,
  url: string,
): Promise<void> {
  try {
    // Fetch /json/version directly — the cached `cdpWsUrl` is only
    // populated after a startSession, but this entrypoint must also
    // work before/between sessions, so we always re-resolve.
    const info = await fetchCdpVersion(5, 500);
    const browserWsUrl = info.webSocketDebuggerUrl as string;
    if (!browserWsUrl) throw new Error("Chrome browser-level CDP URL unavailable");

    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(browserWsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("Target.createTarget timeout"));
      }, 5000);

      ws.on("open", () => {
        // newWindow=false → opens in the existing browser window as a
        // new tab. background=false → activates the new tab so the user
        // lands on it after VNC-connecting.
        ws.send(JSON.stringify({
          id: 1,
          method: "Target.createTarget",
          params: { url, newWindow: false, background: false },
        }));
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.id !== 1) return;
          clearTimeout(timeout);
          ws.close();
          if (msg.error) {
            reject(new Error(`Target.createTarget: ${msg.error.message}`));
            return;
          }
          resolve();
        } catch (err) {
          log(`openPage CDP parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
      });

      ws.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    send({ type: "openPageResponse", requestId, success: true });
    log(`Opened manual page: ${url}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`ERROR: openPage failed: ${error}`);
    send({ type: "openPageResponse", requestId, success: false, error });
  }
}

async function handleScrollRevealLazyContent(
  requestId: string,
  viewport: { width: number; height: number },
  maxRounds: number,
  noChangeLimit: number,
): Promise<void> {
  await withDirectPageCdp("scrollRevealLazyContent", 60_000, async (pageWs, nextId) => {
    const cdpCall = <T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}): Promise<T> => {
      return new Promise((resolve, reject) => {
        const id = nextId();
        const timer = setTimeout(() => {
          pageWs.removeListener("message", onMsg);
          reject(new Error(`${method} timeout`));
        }, 10_000);

        const onMsg = (raw: WebSocket.RawData) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.id === id) {
              clearTimeout(timer);
              pageWs.removeListener("message", onMsg);
              if (msg.error) reject(new Error(`${method}: ${msg.error.message}`));
              else resolve((msg.result || {}) as T);
            }
          } catch (err) {
            log(`scrollReveal cdpCall parse error: ${err instanceof Error ? err.message : String(err)}`);
          }
        };

        pageWs.on("message", onMsg);
        pageWs.send(JSON.stringify({ id, method, params }));
      });
    };

    const { result: initialResult } = await cdpCall<{ result: { value: number } }>(
      "Runtime.evaluate",
      { expression: "document.documentElement.scrollHeight", returnByValue: true },
    );
    let previousHeight = initialResult.value;
    let totalScrollSteps = 0;
    let noChangeCount = 0;

    for (let round = 0; round < maxRounds && noChangeCount < noChangeLimit; round++) {
      const mouseX = viewport.width * (0.3 + Math.random() * 0.4);
      const mouseY = viewport.height * (0.3 + Math.random() * 0.3);
      const steps = 2 + Math.floor(Math.random() * 3);

      pageWs.send(JSON.stringify({
        id: nextId(),
        method: "Input.dispatchMouseEvent",
        params: { type: "mouseMoved", x: mouseX, y: mouseY },
      }));

      for (let i = 0; i < steps; i++) {
        const deltaY = 500 + (Math.random() - 0.5) * 400;
        pageWs.send(JSON.stringify({
          id: nextId(),
          method: "Input.dispatchMouseEvent",
          params: { type: "mouseWheel", x: mouseX, y: mouseY, deltaX: 0, deltaY },
        }));
        const delayMs = 80 + Math.random() * 60;
        await new Promise((r) => setTimeout(r, delayMs));
      }
      totalScrollSteps += steps;

      const { result: heightResult } = await cdpCall<{ result: { value: number } }>(
        "Runtime.evaluate",
        { expression: "document.documentElement.scrollHeight", returnByValue: true },
      );
      const currentHeight = heightResult.value;

      if (currentHeight > previousHeight) {
        previousHeight = currentHeight;
        noChangeCount = 0;
        await new Promise((r) => setTimeout(r, 500));
        const { result: afterResult } = await cdpCall<{ result: { value: number } }>(
          "Runtime.evaluate",
          { expression: "document.documentElement.scrollHeight", returnByValue: true },
        );
        if (afterResult.value > previousHeight) {
          previousHeight = afterResult.value;
        }
      } else {
        noChangeCount++;
      }
    }

    send({
      type: "scrollRevealLazyContentResponse",
      requestId,
      success: true,
      totalScrollSteps,
      finalHeight: previousHeight,
    });
    log(`Scroll-reveal done locally: ${totalScrollSteps} steps, height=${previousHeight}px`);
  });
}

// =============================================================================
// Session management
// =============================================================================

/**
 * Fetch Chrome's /json/version — wait for Chrome to be ready.
 */
async function fetchCdpVersion(maxRetries = 30, retryDelay = 500): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const attempt = () => {
      attempts++;
      const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/version`, (res) => {
        let data = "";
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try { resolve(JSON.parse(data)); }
          catch { reject(new Error(`Invalid JSON from Chrome /json/version`)); }
        });
      });
      req.on("error", () => {
        if (attempts < maxRetries) {
          setTimeout(attempt, retryDelay);
        } else {
          reject(new Error(`Chrome CDP not available after ${maxRetries} attempts`));
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (attempts < maxRetries) {
          setTimeout(attempt, retryDelay);
        } else {
          reject(new Error(`Chrome /json/version timeout after ${maxRetries} attempts`));
        }
      });
    };
    attempt();
  });
}

function profileDirFor(profileId?: number): string {
  return typeof profileId === "number"
    ? `/data/sessions/chrome-profiles/profile-${profileId}`
    : SESSION_BASE_DIR;
}

/**
 * Ensure Chrome is running on this credential's user-data dir before we bridge
 * to it. Chrome's lifecycle lives in chrome-common.sh's supervisor, so we
 * request a switch by writing the desired dir and wait for the supervisor to
 * relaunch onto it (it echoes the live dir into CURRENT_PROFILE_FILE). Waiting
 * for that confirmation is what stops us attaching to the previous account's
 * still-open CDP session during the swap.
 */
async function ensureChromeProfile(profileId?: number): Promise<void> {
  // The supervisor (chrome-common.sh) writes CURRENT_PROFILE_FILE at boot only
  // on images that support per-credential profile switching. If it's absent
  // we're on an older image that pins one user-data dir — skip the switch (and
  // its wait) instead of blocking 30s for a supervisor that never answers.
  // This keeps the auto-updated runtime tarball safe to land before the image
  // is re-pulled.
  if (!fs.existsSync(CURRENT_PROFILE_FILE)) return;

  const target = profileDirFor(profileId);

  const readCurrent = (): string => {
    try {
      return fs.readFileSync(CURRENT_PROFILE_FILE, "utf8").trim();
    } catch {
      return "";
    }
  };

  if (readCurrent() === target) return; // already on the right profile

  log(`Switching Chrome profile dir -> ${target}`);
  fs.mkdirSync("/data/sessions", { recursive: true });
  fs.writeFileSync(DESIRED_PROFILE_FILE, target);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (readCurrent() === target) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  log(`WARNING: Chrome did not confirm profile switch to ${target} in time — proceeding anyway`);
}

async function handleStartSession(_config: { startUrl?: string; headed?: boolean; keepMinimized?: boolean; profileId?: number }): Promise<void> {
  try {
    log("Status: scraping");
    lastCursorPos = null;

    // Stop any existing CDP bridge
    if (currentCdpBridge) {
      log("Closing existing CDP bridge before starting new session");
      currentCdpBridge.close();
      currentCdpBridge = null;
    }

    // Put Chrome on this credential's own profile dir before connecting, so
    // accounts don't share one cookie jar.
    await ensureChromeProfile(_config.profileId);

    // Chrome is already running in the container — just connect to it
    log("Connecting to Chrome CDP...");
    const info = await fetchCdpVersion();
    cdpWsUrl = info.webSocketDebuggerUrl as string;
    versionInfo = info;

    // Create CDP bridge
    log("Creating CDP bridge...");
    currentCdpBridge = await createCdpBridge({
      cdpWsUrl,
      tunnelWs: conn!.rawSocket,
      // No-op for NAS: no window to minimize/restore
      onNewTarget: () => {},
    });

    // Tell the server Chrome is ready
    send({
      type: "sessionReady",
      cdpVersion: versionInfo as {
        Browser: string;
        webSocketDebuggerUrl: string;
      },
    });

    log(`Session started, CDP bridge active (${(versionInfo as { Browser?: string }).Browser || "unknown"})`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log(`ERROR: Failed to start session: ${error}`);
    send({ type: "sessionError", error });
    log("Status: connected");
  }
}

async function reloadAllPages(): Promise<void> {
  if (!cdpWsUrl) return;
  const match = cdpWsUrl.match(/:(\d+)\//);
  if (!match) return;
  const port = match[1];

  const targets: { id: string; type: string; webSocketDebuggerUrl?: string }[] = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json`, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error("Invalid JSON from /json")); }
      });
    });
    req.on("error", reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error("Timeout")); });
  });

  const pages = targets.filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  log(`Reloading ${pages.length} page(s) after CDP release`);

  for (const page of pages) {
    try {
      const pageWs = new WebSocket(page.webSocketDebuggerUrl!);
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => { pageWs.close(); reject(new Error("Timeout")); }, 3000);
        pageWs.on("open", () => {
          pageWs.send(JSON.stringify({ id: 1, method: "Page.reload" }));
          setTimeout(() => { clearTimeout(timeout); pageWs.close(); resolve(); }, 200);
        });
        pageWs.on("error", (err) => { clearTimeout(timeout); reject(err); });
      });
    } catch (err) {
      log(`Failed to reload page ${page.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

async function handleReleaseCdp(): Promise<void> {
  if (!currentCdpBridge || !cdpWsUrl || !conn?.isOpen) return;

  log("Releasing CDP bridge (resetting session state)...");
  currentCdpBridge.close();
  currentCdpBridge = null;

  // No-op: no window to restore in NAS mode (Chrome runs in Xvfb)

  // Reopen with a fresh CDP session
  try {
    currentCdpBridge = await createCdpBridge({
      cdpWsUrl,
      tunnelWs: conn.rawSocket,
      onNewTarget: () => {},
    });
    log("CDP bridge reconnected (fresh session)");
    await reloadAllPages();
  } catch (err) {
    log(`ERROR: Failed to reconnect CDP bridge: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function handleCdpVersionRequest(): Promise<void> {
  if (!versionInfo) {
    // Fetch fresh version info from Chrome
    try {
      versionInfo = await fetchCdpVersion(5, 500);
      cdpWsUrl = versionInfo.webSocketDebuggerUrl as string;
    } catch {
      log("CDP version request but Chrome not available");
      return;
    }
  }

  log(`  -> cdpVersionResponse (${(versionInfo as { Browser?: string }).Browser || "unknown"})`);
  send({
    type: "cdpVersionResponse",
    version: versionInfo,
  });
}

function stopSession(): void {
  if (currentCdpBridge) {
    log("Closing CDP bridge...");
    currentCdpBridge.close();
    currentCdpBridge = null;
  }
  stopVncRelay();
  lastCursorPos = null;
  // Reset cloud log-forwarding to safe defaults — the next session's
  // logConfig will refresh this if needed.
  logForwardingVerbose = false;
  // Chrome keeps running — it's managed by the entrypoint, not the tunnel client
}

// =============================================================================
// Message handling
// =============================================================================

function handleMessage(msg: ServerMessage): void {
  if (msg.type !== "cdp" && msg.type !== "cdpBinary") {
    logTrace(`  <- ${msg.type}`);
  }

  switch (msg.type) {
    case "startSession":
      log(`  Config: headed=${msg.config.headed ?? true}, startUrl=${msg.config.startUrl || "(none)"}, profileId=${msg.config.profileId ?? "(none)"}`);
      handleStartSession(msg.config);
      break;

    case "stopSession":
      stopSession();
      log("Status: connected");
      break;

    case "releaseCdp":
      handleReleaseCdp();
      break;

    case "cdpVersionRequest":
      handleCdpVersionRequest();
      break;

    case "typeText":
      withStep(msg.stepId, () => withInputGate(() => handleTypeText(msg.text, msg.charDelayMs, msg.submitAfter ?? false))).catch((err) => {
        log(`ERROR: typeText failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "clearInput":
      withStep(msg.stepId, () => withInputGate(() => handleClearInput())).catch((err) => {
        log(`ERROR: clearInput failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "scrollWheel":
      withStep(msg.stepId, () => withInputGate(() => handleScrollWheel(msg.mouseX, msg.mouseY, msg.steps))).catch((err) => {
        log(`ERROR: scrollWheel failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "mouseMove":
      withStep(msg.stepId, () => withInputGate(() => handleMouseMove(msg.steps))).catch((err) => {
        log(`ERROR: mouseMove failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "screenshotRequest":
      withStep(msg.stepId, () =>
        handleScreenshotRequest(
          msg.requestId,
          msg.format || "jpeg",
          msg.quality ?? 50,
          msg.viaX11 ?? false,
        ),
      ).catch((err) => {
        log(`ERROR: screenshot failed: ${err instanceof Error ? err.message : String(err)}`);
        send({ type: "screenshotResponse", requestId: msg.requestId, data: null });
      });
      break;

    case "clickElement":
      withStep(msg.stepId, () =>
        withInputGate(() => handleClickElement(msg.requestId, msg.selector, msg.timeout, msg.modifiers, msg.button)),
      ).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`ERROR: clickElement failed: ${error}`);
        send({ type: "clickElementResponse", requestId: msg.requestId, success: false, error });
      });
      break;

    case "clickAt":
      withStep(msg.stepId, () =>
        withInputGate(() => handleClickAt(msg.requestId, msg.x, msg.y, msg.timeout, msg.modifiers, msg.button)),
      ).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`ERROR: clickAt failed: ${error}`);
        send({ type: "clickAtResponse", requestId: msg.requestId, success: false, error });
      });
      break;

    case "scrollRevealLazyContent":
      withStep(msg.stepId, () =>
        withInputGate(() => handleScrollRevealLazyContent(msg.requestId, msg.viewport, msg.maxRounds, msg.noChangeLimit)),
      ).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`ERROR: scrollRevealLazyContent failed: ${error}`);
        send({ type: "scrollRevealLazyContentResponse", requestId: msg.requestId, success: false, totalScrollSteps: 0, finalHeight: 0, error });
      });
      break;

    case "logConfig":
      // Server is opening a scrape — switch on debug forwarding if it asked
      // for verbose logs; otherwise we still forward info+ levels by default.
      logForwardingVerbose = !!msg.verbose;
      log(`Log forwarding: ${logForwardingVerbose ? "verbose (debug+)" : "info+"} (run ${msg.runId ?? "(none)"})`);
      break;

    case "setMinimized":
      // No-op in NAS mode — Chrome runs in Xvfb, no window to minimize
      log(`setMinimized(${msg.minimized}) — ignored (NAS mode)`);
      break;

    case "startVnc":
      startVncRelay(send);
      break;

    case "stopVnc":
      stopVncRelay();
      break;

    case "vncData":
      handleVncData(msg.data);
      break;

    case "rawMouseEvent":
      handleRawMouseEvent(msg).catch((err) => {
        log(`ERROR: rawMouseEvent failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "rawScrollEvent":
      handleRawScrollEvent(msg).catch((err) => {
        log(`ERROR: rawScrollEvent failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "rawKeyEvent":
      handleRawKeyEvent(msg).catch((err) => {
        log(`ERROR: rawKeyEvent failed: ${err instanceof Error ? err.message : String(err)}`);
      });
      break;

    case "openPage":
      handleOpenPage(msg.requestId, msg.url).catch((err) => {
        const error = err instanceof Error ? err.message : String(err);
        log(`ERROR: openPage failed: ${error}`);
        send({ type: "openPageResponse", requestId: msg.requestId, success: false, error });
      });
      break;

    case "cdp":
    case "cdpBinary":
      // Handled by the CDP bridge listener
      break;

    default:
      log(`Unknown message type: ${(msg as { type: string }).type}`);
  }
}

// =============================================================================
// Connection management
// =============================================================================

export function connect(config: TunnelConfig): void {
  if (!config.serverUrl || !config.apiToken) {
    log("ERROR: SJS_SERVER_URL and SJS_API_TOKEN are required");
    process.exit(1);
  }

  log(`Handlers: ${SUPPORTED_HANDLERS.join(", ")}`);

  if (!conn) {
    conn = new TunnelConnection({
      serverUrl: config.serverUrl,
      auth: {
        token: config.apiToken,
        version: config.buildVersion,
        headless: true,
      },
      log,
      onStatusChange: (s) => log(`Status: ${s}`),
      onAuthOk: (msg) => {
        cloudLogsEnabled = true;
        log(`  Profile ID: ${msg.profileId}`);
      },
      onMessage: (msg) => handleMessage(msg as ServerMessage),
      onDisconnect: ({ code }) => {
        cloudLogsEnabled = false;
        stopSession();
        // The server uses 4004 for hard auth failure — bail rather than
        // burn CPU on a token that will never authenticate.
        if (code === 4004) process.exit(1);
      },
    });
  }

  conn.connect();
}

export function disconnect(): void {
  conn?.disconnect();
  stopSession();
}
