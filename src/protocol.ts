/**
 * Tunnel protocol message types.
 *
 * Shared between the SJS server (worker) and the desktop app.
 * All messages are JSON over WebSocket with a `type` discriminator.
 *
 * This is a standalone copy — keep in sync with
 * cloud/src/server/browser/tunnel/protocol.ts
 */

// ============================================================================
// Desktop App → Server
// ============================================================================

export interface TunnelAuthMessage {
  type: "auth";
  token: string;
  version: string;
  /** True when the tunnel client runs on a virtual display (Xvfb/Docker) */
  headless?: boolean;
}

export interface TunnelSessionReady {
  type: "sessionReady";
  /** Chrome's /json/version response, forwarded so Playwright can connect */
  cdpVersion: {
    Browser: string;
    webSocketDebuggerUrl: string;
    [key: string]: unknown;
  };
}

export interface TunnelSessionError {
  type: "sessionError";
  error: string;
}

export interface TunnelCdpVersionResponse {
  type: "cdpVersionResponse";
  version: Record<string, unknown>;
}

export interface TunnelPong {
  type: "pong";
}

/**
 * Client → Server: forward a tunnel-client log line for cross-process
 * debugging. The server attaches `run_id` (looked up from the connection's
 * active scrape binding) and inserts into `scraper_logs` with
 * `source='tunnel'`. Dropped when no scrape is bound to the connection.
 *
 * `stepId`, when set, was inherited from a server-issued command's stepId —
 * lets the UI group cloud + tunnel logs under the same step subtree.
 */
export interface TunnelClientLog {
  type: "clientLog";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  /** Client-side emit time (epoch ms). Server inserts use receive time. */
  ts: number;
  stepId?: number;
  /** Free-form structured payload, stored on the row alongside the message. */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Server → Desktop App
// ============================================================================

export interface TunnelAuthOk {
  type: "authOk";
  /** The owning user's ID. A device is registered against its user (not
   *  a profile) so all the user's profiles see the same connection. */
  userId: string;
}

export interface TunnelAuthFail {
  type: "authFail";
  error: string;
}

export interface TunnelStartSession {
  type: "startSession";
  config: {
    startUrl?: string;
    headed?: boolean;
    keepMinimized?: boolean;
    /**
     * Platform-profile id (one set of credentials). Selects a per-credential
     * Chrome user-data dir so each account keeps its own cookies / remember-me
     * state instead of sharing one profile. Optional for back-compat.
     */
    profileId?: number;
  };
}

export interface TunnelStopSession {
  type: "stopSession";
}

export interface TunnelReleaseCdp {
  type: "releaseCdp";
}

export interface TunnelCdpVersionRequest {
  type: "cdpVersionRequest";
}

export interface TunnelTypeText {
  type: "typeText";
  text: string;
  /** Per-character delay in ms */
  charDelayMs: number;
  /** If true, press Enter after typing (or just Enter if text is empty) — also OS-level. */
  submitAfter?: boolean;
  /**
   * If set, the client sends a `typeTextResponse` with the same id once the
   * OS-level typing (and optional Enter) has actually finished. Lets the
   * cloud await real completion instead of estimating, which was racy: the
   * estimate didn't account for xdotool process-spawn time, so a fast Enter
   * via CDP could land before the last keystroke (run 723 dropped the final
   * "t" of "React" → search for "Reac" → 0 results).
   *
   * Optional for compatibility with older clients that don't send the ack;
   * the cloud falls back to a generous time-based wait when no response
   * arrives.
   */
  requestId?: string;
  /**
   * Active step on the cloud side at the time this command was issued. The
   * client sets its own AsyncLocalStorage to this value while running the
   * handler so any `clientLog` it emits inherits the same step grouping.
   * Optional for back-compat with older clients.
   */
  stepId?: number;
}

/**
 * Client → Server: ack for `typeText`. Sent only when the typeText included
 * a `requestId`. `success: false` means the OS-level injection failed (and
 * the CDP fallback also failed if attempted).
 */
export interface TunnelTypeTextResponse {
  type: "typeTextResponse";
  requestId: string;
  success: boolean;
  error?: string;
}

/** Server → Client: clear the focused input via OS-level select-all + delete.
 *  Uses xdotool / osascript / SendKeys instead of CDP so it doesn't trigger
 *  bot-detection on auth pages. */
export interface TunnelClearInput {
  type: "clearInput";
  stepId?: number;
}

export interface TunnelScrollWheel {
  type: "scrollWheel";
  mouseX: number;
  mouseY: number;
  /** Pre-computed scroll steps (server computes randomization) */
  steps: { deltaY: number; delayMs: number }[];
  stepId?: number;
}

export interface TunnelMouseMove {
  type: "mouseMove";
  /** Pre-computed bezier path with delays (server computes curve + tremor) */
  steps: { x: number; y: number; delayMs: number }[];
  stepId?: number;
}

export interface TunnelScreenshotRequest {
  type: "screenshotRequest";
  requestId: string;
  format?: "jpeg" | "png";
  quality?: number;
  /**
   * When true, the NAS captures the screenshot via X11 (scrot) instead of
   * Chrome's `Page.captureScreenshot` CDP call. Used by the debug-screenshot
   * path so screenshot rendering doesn't block Chrome's CDP queue and starve
   * concurrent clickAt acks. Default false → existing CDP path (VNC live
   * preview, etc.).
   */
  viaX11?: boolean;
  stepId?: number;
}

export interface TunnelClickElement {
  type: "clickElement";
  requestId: string;
  selector: string;
  /** Click timeout in ms (default 5000) */
  timeout: number;
  /** Keyboard modifiers to hold during click (e.g. ["Control"] for Ctrl+click) */
  modifiers?: ("Control" | "Shift" | "Alt" | "Meta")[];
  /**
   * Mouse button — defaults to "left". Older tunnel clients
   * (before tunnel-client v0.2.0-nas / desktop v0.4.0-beta.9) ignore this and
   * always click left. Calling code that needs middle-click should fall back
   * to a Playwright-CDP click when this field is required.
   */
  button?: "left" | "middle" | "right";
  stepId?: number;
}

/**
 * Click at viewport-relative CSS-pixel coordinates without resolving a
 * selector. Used when the caller already has an authoritative element handle
 * (Playwright) and just needs OS-level focus to move to that point so
 * subsequent xdotool typing lands in the right input. Site-agnostic — works
 * with shadow DOM, iframes, dynamic IDs, or anything else `selector`-based
 * resolution chokes on.
 *
 * Coordinates are CSS pixels relative to the main-frame viewport (the same
 * coord space Playwright's `page.mouse.click(x, y)` uses). The tunnel-client
 * translates page→screen coords and drives xdotool.
 */
export interface TunnelClickAt {
  type: "clickAt";
  requestId: string;
  /** Viewport-relative CSS-pixel coordinate */
  x: number;
  /** Viewport-relative CSS-pixel coordinate */
  y: number;
  /** Click timeout in ms (default 5000) */
  timeout: number;
  modifiers?: ("Control" | "Shift" | "Alt" | "Meta")[];
  button?: "left" | "middle" | "right";
  stepId?: number;
}

export interface TunnelScrollRevealLazyContent {
  type: "scrollRevealLazyContent";
  requestId: string;
  /** Viewport dimensions for mouse positioning */
  viewport: { width: number; height: number };
  /** Max scroll rounds (default: 10) */
  maxRounds: number;
  /** Consecutive no-change rounds before stopping (default: 3) */
  noChangeLimit: number;
  stepId?: number;
}

export interface TunnelSetMinimized {
  type: "setMinimized";
  minimized: boolean;
}

export interface TunnelPing {
  type: "ping";
}

/**
 * Server → Client: configure tunnel-client log forwarding for the current
 * session. Sent once when a scrape session opens. `verbose=true` tells the
 * client to forward debug-level log lines too; off by default. `runId` is
 * informational (the server already knows it from the connection binding).
 */
export interface TunnelLogConfig {
  type: "logConfig";
  verbose: boolean;
  runId?: number;
}

// ============================================================================
// Desktop App → Server (continued)
// ============================================================================

export interface TunnelScrollRevealLazyContentResponse {
  type: "scrollRevealLazyContentResponse";
  requestId: string;
  success: boolean;
  /** Total scroll steps performed */
  totalScrollSteps: number;
  /** Final scroll height */
  finalHeight: number;
  error?: string;
}

export interface TunnelScreenshotResponse {
  type: "screenshotResponse";
  requestId: string;
  /** base64-encoded image data, or null on failure */
  data: string | null;
}

export interface TunnelClickElementResponse {
  type: "clickElementResponse";
  requestId: string;
  success: boolean;
  /** Whether the click caused a new browser tab to open (detected locally) */
  newTabOpened?: boolean;
  error?: string;
}

export interface TunnelClickAtResponse {
  type: "clickAtResponse";
  requestId: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// Bidirectional (CDP relay)
// ============================================================================

/** CDP text frame relayed through the tunnel */
export interface TunnelCdpMessage {
  type: "cdp";
  data: string;
}

/** CDP binary frame relayed through the tunnel (base64-encoded) */
export interface TunnelCdpBinary {
  type: "cdpBinary";
  data: string; // base64
}

// ============================================================================
// VNC relay
// ============================================================================

/** Server → Client: open a local VNC connection */
export interface TunnelStartVnc {
  type: "startVnc";
}

/** Server → Client: close the VNC connection */
export interface TunnelStopVnc {
  type: "stopVnc";
}

/** Client → Server: VNC connection established */
export interface TunnelVncReady {
  type: "vncReady";
}

/** Client → Server: VNC connection failed */
export interface TunnelVncError {
  type: "vncError";
  error: string;
}

/** Bidirectional: raw VNC/RFB data (base64-encoded) */
export interface TunnelVncData {
  type: "vncData";
  data: string; // base64
}

// ============================================================================
// Interactive browser control — raw CDP input events
// ============================================================================

/** Server → Client: raw mouse event dispatched via CDP Input.dispatchMouseEvent */
export interface TunnelRawMouseEvent {
  type: "rawMouseEvent";
  x: number;
  y: number;
  eventType: "mousePressed" | "mouseReleased" | "mouseMoved";
  button?: "left" | "right" | "middle";
  clickCount?: number;
  modifiers?: number;
}

/** Server → Client: raw scroll event dispatched via CDP Input.dispatchMouseEvent */
export interface TunnelRawScrollEvent {
  type: "rawScrollEvent";
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
}

/** Server → Client: raw key event dispatched via CDP Input.dispatchKeyEvent */
export interface TunnelRawKeyEvent {
  type: "rawKeyEvent";
  eventType: "keyDown" | "keyUp";
  key: string;
  code: string;
  text?: string;
  modifiers?: number;
}

// ============================================================================
// Manual-browser entrypoint
// ============================================================================

/**
 * Server → Client: open a new tab in the running Chrome and navigate it to
 * `url`. Used by the "Open browser" button on the task page — lets the
 * user reach the platform in their NAS Chrome (via VNC) to fix things
 * the scraper can't, e.g. toggle a site's display language. No session,
 * no CDP bridge, no scrape — just a Target.createTarget through the
 * browser-level CDP.
 */
export interface TunnelOpenPage {
  type: "openPage";
  requestId: string;
  url: string;
}

/** Client → Server: ack for `openPage`. */
export interface TunnelOpenPageResponse {
  type: "openPageResponse";
  requestId: string;
  success: boolean;
  error?: string;
}

// ============================================================================
// Union types
// ============================================================================

export type ClientMessage =
  | TunnelAuthMessage
  | TunnelSessionReady
  | TunnelSessionError
  | TunnelCdpVersionResponse
  | TunnelScreenshotResponse
  | TunnelClickElementResponse
  | TunnelClickAtResponse
  | TunnelScrollRevealLazyContentResponse
  | TunnelTypeTextResponse
  | TunnelOpenPageResponse
  | TunnelCdpMessage
  | TunnelCdpBinary
  | TunnelVncReady
  | TunnelVncError
  | TunnelVncData
  | TunnelClientLog
  | TunnelPong;

export type ServerMessage =
  | TunnelAuthOk
  | TunnelAuthFail
  | TunnelStartSession
  | TunnelStopSession
  | TunnelReleaseCdp
  | TunnelCdpVersionRequest
  | TunnelTypeText
  | TunnelClearInput
  | TunnelScrollWheel
  | TunnelMouseMove
  | TunnelScreenshotRequest
  | TunnelClickElement
  | TunnelClickAt
  | TunnelScrollRevealLazyContent
  | TunnelSetMinimized
  | TunnelCdpMessage
  | TunnelCdpBinary
  | TunnelStartVnc
  | TunnelStopVnc
  | TunnelVncData
  | TunnelRawMouseEvent
  | TunnelRawScrollEvent
  | TunnelRawKeyEvent
  | TunnelOpenPage
  | TunnelLogConfig
  | TunnelPing;
