/**
 * VNC relay for sjs-browser.
 *
 * Opens a TCP connection to the local x11vnc server and relays
 * raw RFB frames bidirectionally through the channel WebSocket.
 */

import net from "net";
import type { ClientMessage } from "./protocol.js";

const VNC_HOST = "127.0.0.1";
const VNC_PORT = parseInt(process.env.SJS_VNC_PORT || "5900", 10);

let vncSocket: net.Socket | null = null;

function log(message: string): void {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}] [VNC] ${message}`);
}

export function startVncRelay(send: (msg: ClientMessage) => void): void {
  if (vncSocket) {
    log("Closing existing VNC connection before starting new relay");
    vncSocket.destroy();
    vncSocket = null;
  }

  log(`Connecting to VNC at ${VNC_HOST}:${VNC_PORT}...`);

  vncSocket = net.createConnection({ host: VNC_HOST, port: VNC_PORT });

  vncSocket.on("connect", () => {
    log("Connected to VNC server");
    send({ type: "vncReady" });
  });

  vncSocket.on("data", (chunk: Buffer) => {
    send({ type: "vncData", data: chunk.toString("base64") });
  });

  vncSocket.on("error", (err) => {
    log(`VNC connection error: ${err.message}`);
    send({ type: "vncError", error: err.message });
    vncSocket = null;
  });

  vncSocket.on("close", () => {
    log("VNC connection closed");
    vncSocket = null;
  });
}

export function handleVncData(base64Data: string): void {
  if (vncSocket && !vncSocket.destroyed) {
    vncSocket.write(Buffer.from(base64Data, "base64"));
  }
}

export function stopVncRelay(): void {
  if (vncSocket) {
    log("Stopping VNC relay");
    vncSocket.destroy();
    vncSocket = null;
  }
}
