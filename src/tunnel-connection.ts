/**
 * Shared WebSocket lifecycle for the SJS tunnel.
 *
 * Owns: connect, auth handshake, handshake timer, ping watchdog,
 * exponential-backoff reconnect. Forwards all non-builtin server messages
 * (anything other than ping/authOk/authFail) to the supplied `onMessage`
 * callback so the application can route them.
 *
 * MIRROR — keep this file in sync between:
 *   - cloud/sjs-browser/src/tunnel-connection.ts
 *   - desktop/src/main/tunnel-connection.ts
 * The lifecycle behaviour must stay identical across both clients; bug
 * fixes and timeout tweaks belong here, not in the consuming app code.
 */

import WebSocket from "ws";

export type TunnelStatus =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting";

export interface AuthPayload {
  token: string;
  version: string;
  headless?: boolean;
}

export interface AuthOkMessage {
  type: "authOk";
  userId?: string;
  profileId?: string;
}

export interface DisconnectInfo {
  code: number;
  reason: string;
  /** True iff the connection had reached `connected` before this close. */
  wasConnected: boolean;
}

export interface TunnelConnectionOptions {
  serverUrl: string;
  auth: AuthPayload;
  /** Called when authOk lands. The connection is now usable for sends. */
  onAuthOk: (msg: AuthOkMessage) => void;
  /** Called for every non-builtin server message. */
  onMessage: (msg: { type: string; [k: string]: unknown }) => void;
  /** Called on every disconnect, after cleanup but before reconnect is scheduled. */
  onDisconnect: (info: DisconnectInfo) => void;
  /** Status updates for UI/log hooks. */
  onStatusChange?: (status: TunnelStatus) => void;
  /** Logging hook. The module adds no prefix — caller controls format. */
  log: (msg: string) => void;
  /** Default true. When false, the close handler does not schedule a reconnect. */
  autoReconnect?: boolean;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
// Server pings every 30s; if no ping arrives within 75s the connection
// is treated as stale and the socket is terminated to trigger reconnect.
const PING_WATCHDOG_INTERVAL_MS = 15_000;
const PING_WATCHDOG_TIMEOUT_MS = 75_000;
// Reap a connect/auth that stalls — server accepts TCP but never finishes
// the upgrade, or upgrade lands but authOk never arrives. The ping
// watchdog only covers the post-authOk state, so without this a half-open
// ws sits in CONNECTING/AUTHENTICATING forever and the readyState guard
// at the top of connect() blocks every subsequent reconnect attempt.
const HANDSHAKE_TIMEOUT_MS = 15_000;

export class TunnelConnection {
  private ws: WebSocket | null = null;
  private status: TunnelStatus = "disconnected";
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts = 0;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private pingWatchdog: NodeJS.Timeout | null = null;
  private lastPingReceived = 0;
  private intentionalDisconnect = false;

  constructor(private readonly opts: TunnelConnectionOptions) {}

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Underlying socket for performance-sensitive consumers (the CDP bridge
   * attaches its own listener to avoid the parse/dispatch round-trip per
   * frame). Only valid while a session is active.
   */
  get rawSocket(): WebSocket {
    if (!this.ws) throw new Error("TunnelConnection: no active socket");
    return this.ws;
  }

  /** Send a JSON message. Silently drops if the socket is not open. */
  send(msg: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  connect(): void {
    this.intentionalDisconnect = false;

    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN ||
        this.ws.readyState === WebSocket.CONNECTING)
    ) {
      this.opts.log("Already connected/connecting");
      return;
    }

    this.setStatus("connecting");
    this.opts.log(`Connecting to ${this.opts.serverUrl}...`);

    const ws = new WebSocket(this.opts.serverUrl);
    this.ws = ws;
    this.startHandshakeTimer(ws);

    ws.on("open", () => {
      this.setStatus("authenticating");
      this.send({
        type: "auth",
        token: this.opts.auth.token,
        version: this.opts.auth.version,
        headless: this.opts.auth.headless,
      });
    });

    ws.on("message", (raw) => this.handleMessage(raw));

    ws.on("close", (code, reason) => {
      const wasConnected = this.status === "connected";
      this.setStatus("disconnected");
      this.stopHandshakeTimer();
      this.stopPingWatchdog();
      const reasonStr = reason.toString();
      this.opts.log(`Disconnected (code ${code}: ${reasonStr})`);
      this.opts.onDisconnect({ code, reason: reasonStr, wasConnected });

      if (code === 4004 || this.intentionalDisconnect) {
        if (code === 4004) {
          this.opts.log("Auth failed — check your API token");
        }
        this.intentionalDisconnect = false;
        return;
      }

      if (this.opts.autoReconnect === false) return;

      const delay = Math.min(
        1000 * Math.pow(2, this.reconnectAttempts),
        MAX_RECONNECT_DELAY_MS,
      );
      this.reconnectAttempts++;
      this.setStatus("reconnecting");
      this.opts.log(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})...`);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
    });

    ws.on("error", (err) => {
      this.opts.log(`ERROR: WebSocket error: ${err.message}`);
    });
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempts = 0;
    this.stopHandshakeTimer();
    this.stopPingWatchdog();

    if (this.ws) {
      this.ws.removeAllListeners();
      this.ws.terminate();
      this.ws = null;
    }
    this.setStatus("disconnected");
  }

  private setStatus(s: TunnelStatus): void {
    this.status = s;
    this.opts.onStatusChange?.(s);
  }

  private handleMessage(raw: WebSocket.RawData): void {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw.toString());
    } catch (err) {
      this.opts.log(
        `Invalid message from server: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    switch (msg.type) {
      case "ping":
        this.lastPingReceived = Date.now();
        this.send({ type: "pong" });
        return;

      case "authOk":
        this.stopHandshakeTimer();
        this.setStatus("connected");
        this.reconnectAttempts = 0;
        this.lastPingReceived = Date.now();
        this.startPingWatchdog();
        this.opts.onAuthOk(msg as AuthOkMessage);
        return;

      case "authFail":
        this.opts.log(`ERROR: Auth failed: ${String(msg.error ?? "unknown")}`);
        // Server follows with close(4004); reconnect-suppression happens there.
        return;

      default:
        this.opts.onMessage(msg as { type: string; [k: string]: unknown });
    }
  }

  private startHandshakeTimer(socket: WebSocket): void {
    this.stopHandshakeTimer();
    this.handshakeTimer = setTimeout(() => {
      this.opts.log(
        `Handshake timeout after ${HANDSHAKE_TIMEOUT_MS / 1000}s — terminating`,
      );
      this.handshakeTimer = null;
      socket.terminate();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private stopHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private startPingWatchdog(): void {
    this.stopPingWatchdog();
    this.pingWatchdog = setInterval(() => {
      if (
        this.lastPingReceived > 0 &&
        Date.now() - this.lastPingReceived > PING_WATCHDOG_TIMEOUT_MS
      ) {
        this.opts.log("Server ping timeout — connection appears stale, forcing reconnect");
        this.stopPingWatchdog();
        this.ws?.terminate();
      }
    }, PING_WATCHDOG_INTERVAL_MS);
  }

  private stopPingWatchdog(): void {
    if (this.pingWatchdog) {
      clearInterval(this.pingWatchdog);
      this.pingWatchdog = null;
    }
  }
}
