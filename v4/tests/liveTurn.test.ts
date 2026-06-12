import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server/main.js";
import { decodeServerTextFrames } from "../src/server/transport/webSocket.js";

const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];

afterEach(async () => {
  for (const started of servers.splice(0)) await started.close();
});

function handshake(port: string, token: string): string {
  return [
    `GET /ws?token=${token}&since=0 HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    `Origin: http://127.0.0.1:${port}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "\r\n",
  ].join("\r\n");
}

function maskedTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const mask = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i]! ^ mask[i % 4]!;
  return Buffer.concat([Buffer.from([0x81, 0x80 | payload.length]), mask, masked]);
}

describe("live: a chat_submit over the wire runs a turn through the executor", () => {
  it("classifies a command via /risk and streams the verdict back", async () => {
    const started = await startServer({ port: 0, token: "f".repeat(64), dbPath: ":memory:" });
    servers.push(started);
    const port = new URL(started.url).port;

    const socket = connect(Number(port), "127.0.0.1");
    await once(socket, "connect");

    const chunks: Buffer[] = [];
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));

    socket.write(handshake(port, started.token));
    await delay(100);
    socket.write(maskedTextFrame(JSON.stringify({ type: "chat_submit", text: "/risk rm -rf /" })));
    await delay(300);

    const all = Buffer.concat(chunks);
    const marker = all.indexOf("\r\n\r\n");
    const events = decodeServerTextFrames(all.subarray(marker + 4));

    expect(events.some((event) => event.type === "turn_started")).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.text.includes('"tier":2'))).toBe(true);
    expect(events.some((event) => event.type === "turn_finished" && event.ok)).toBe(true);

    socket.destroy();
  });
});
