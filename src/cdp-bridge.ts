/**
 * CDP bridge between the tunnel WebSocket and Chrome's CDP WebSocket.
 *
 * Relays all CDP traffic bidirectionally:
 * - Server (via tunnel) → Chrome
 * - Chrome → Server (via tunnel)
 *
 * Copied from desktop/src/main/cdp-bridge.ts — identical logic.
 */

import WebSocket from "ws";
import type { ClientMessage } from "./protocol.js";

interface CdpBridgeOptions {
  /** Chrome's CDP WebSocket URL */
  cdpWsUrl: string;
  /** The tunnel WebSocket (to the server) */
  tunnelWs: WebSocket;
  /** Called when the server sends Target.setAutoAttach (Playwright reconnecting) */
  onPlaywrightReconnect?: () => void;
  /** Called when Chrome reports a new target attached (new tab opened) */
  onNewTarget?: () => void;
}

interface CdpBridge {
  close: () => void;
}

export function createCdpBridge(options: CdpBridgeOptions): Promise<CdpBridge> {
  const { cdpWsUrl, tunnelWs, onPlaywrightReconnect, onNewTarget } = options;
  let playwrightReconnectFired = false;

  return new Promise((resolve, reject) => {
    console.log(`[CDP Bridge] Connecting to Chrome: ${cdpWsUrl}`);

    const chromeWs = new WebSocket(cdpWsUrl);

    chromeWs.on("open", () => {
      console.log("[CDP Bridge] Connected to Chrome CDP");

      let serverToChrome = 0;
      let chromeToServer = 0;
      let serverToChromeBytes = 0;
      let chromeToServerBytes = 0;
      const statsInterval = setInterval(() => {
        if (serverToChrome > 0 || chromeToServer > 0) {
          console.log(
            `[CDP Bridge] Traffic: server→chrome ${serverToChrome} msgs (${fmtBytes(serverToChromeBytes)}), ` +
            `chrome→server ${chromeToServer} msgs (${fmtBytes(chromeToServerBytes)})`,
          );
          serverToChrome = 0;
          chromeToServer = 0;
          serverToChromeBytes = 0;
          chromeToServerBytes = 0;
        }
      }, 10_000);

      const pendingTargets = new Map<string, NodeJS.Timeout>();
      let nextResumeId = 1_000_000;

      /**
       * Ids of commands THIS bridge sent on Playwright's CDP socket.
       *
       * The auto-resume below is our own command, not a relayed one, but Chrome
       * replies to it on the same socket and we forward everything Chrome says
       * straight to the server. Playwright then receives a reply to a request it
       * never issued, finds no pending callback, and throws a bare
       * "Assertion error" from CRSession._onMessage — killing the run.
       *
       * The high starting number avoids COLLIDING with Playwright's ids, which
       * was never the problem: Playwright rejects any id it did not issue. So
       * the reply has to be swallowed here rather than merely made distinctive.
       *
       * Observed as `UNSOLICITED reply id=1000000` on run 1044, arriving as the
       * last message before the socket died.
       */
      const selfIssuedIds = new Set<number>();

      // Server → Chrome
      const tunnelHandler = (rawData: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(rawData.toString());

          if (msg.type === "cdp" && chromeWs.readyState === WebSocket.OPEN) {
            let cdpData = msg.data;
            try {
              const cdp = JSON.parse(msg.data);
              if (cdp.method === "Runtime.runIfWaitingForDebugger" && cdp.sessionId) {
                const timer = pendingTargets.get(cdp.sessionId);
                if (timer) {
                  clearTimeout(timer);
                  pendingTargets.delete(cdp.sessionId);
                }
              }
              if (cdp.method === "Target.setAutoAttach" && !playwrightReconnectFired) {
                playwrightReconnectFired = true;
                onPlaywrightReconnect?.();
              }
              if (cdp.method === "Target.createTarget") {
                cdp.params = {
                  ...cdp.params,
                  background: true,
                  focus: false,
                };
                cdpData = JSON.stringify(cdp);
              }
            } catch { /* not JSON or no method — relay as-is */ }

            chromeWs.send(cdpData);
            serverToChrome++;
            serverToChromeBytes += msg.data.length;
          } else if (msg.type === "cdpBinary" && chromeWs.readyState === WebSocket.OPEN) {
            const buf = Buffer.from(msg.data, "base64");
            chromeWs.send(buf);
            serverToChrome++;
            serverToChromeBytes += buf.length;
          }
        } catch (err) {
          console.log(`[CDP Bridge] Tunnel message parse error: ${err instanceof Error ? err.message : String(err)}`);
        }
      };
      tunnelWs.on("message", tunnelHandler);

      // Chrome → Server
      chromeWs.on("message", (data, isBinary) => {
        if (tunnelWs.readyState !== WebSocket.OPEN) return;

        const dataLen = isBinary ? (data as Buffer).length : data.toString().length;
        chromeToServer++;
        chromeToServerBytes += dataLen;

        if (!isBinary) {
          try {
            const cdp = JSON.parse(data.toString());

            // Swallow the reply to a command we issued ourselves. Forwarding it
            // is what kills Playwright — see selfIssuedIds above. Only replies
            // carry an id; events do not, so this cannot drop an event.
            if (typeof cdp.id === "number" && selfIssuedIds.has(cdp.id)) {
              selfIssuedIds.delete(cdp.id);
              console.log(`[CDP Bridge] Swallowed reply to our own command (id ${cdp.id})`);
              return;
            }

            if (
              cdp.method === "Target.attachedToTarget" &&
              cdp.params?.waitingForDebugger &&
              cdp.params?.sessionId
            ) {
              const sessionId = cdp.params.sessionId as string;
              onNewTarget?.();
              const timer = setTimeout(() => {
                pendingTargets.delete(sessionId);
                if (chromeWs.readyState === WebSocket.OPEN) {
                  const resumeId = nextResumeId++;
                  selfIssuedIds.add(resumeId);
                  const resumeMsg = JSON.stringify({
                    id: resumeId,
                    method: "Runtime.runIfWaitingForDebugger",
                    sessionId,
                  });
                  chromeWs.send(resumeMsg);
                  console.log(`[CDP Bridge] Auto-resumed unhandled target (session ${sessionId.slice(0, 8)}...)`);
                }
              }, 500);
              pendingTargets.set(sessionId, timer);
            }
          } catch { /* not JSON — just relay */ }
        }

        if (isBinary) {
          const msg: ClientMessage = {
            type: "cdpBinary",
            data: (data as Buffer).toString("base64"),
          };
          tunnelWs.send(JSON.stringify(msg));
        } else {
          const msg: ClientMessage = {
            type: "cdp",
            data: data.toString(),
          };
          tunnelWs.send(JSON.stringify(msg));
        }
      });

      chromeWs.on("close", () => {
        console.log("[CDP Bridge] Chrome CDP disconnected");
        clearInterval(statsInterval);
        tunnelWs.removeListener("message", tunnelHandler);
      });

      chromeWs.on("error", (err) => {
        console.error("[CDP Bridge] Chrome CDP error:", err.message);
      });

      resolve({
        close() {
          clearInterval(statsInterval);
          for (const timer of pendingTargets.values()) clearTimeout(timer);
          pendingTargets.clear();
          // A resume whose reply never arrived would otherwise sit here for the
          // life of the process.
          selfIssuedIds.clear();
          tunnelWs.removeListener("message", tunnelHandler);
          if (chromeWs.readyState === WebSocket.OPEN) {
            chromeWs.close();
          }
          console.log("[CDP Bridge] Closed");
        },
      });
    });

    chromeWs.on("error", (err) => {
      reject(new Error(`Failed to connect to Chrome CDP: ${err.message}`));
    });
  });
}

function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
