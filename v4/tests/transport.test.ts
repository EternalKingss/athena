import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { startServer } from "../src/server/main.js";
import { decodeServerTextFrames } from "../src/server/transport/webSocket.js";

const servers: Array<Awaited<ReturnType<typeof startServer>>> = [];

afterEach(async () => {
  for (const started of servers.splice(0)) {
    await started.close();
  }
});

describe("secure WebSocket transport", () => {
  it("authenticates loopback clients and replays events after since", async () => {
    const started = await startServer({ port: 0, token: "b".repeat(64), dbPath: ":memory:" });
    servers.push(started);
    const port = new URL(started.url).port;

    const socket = connect(Number(port), "127.0.0.1");
    await once(socket, "connect");
    socket.write(handshake({ port, token: started.token, since: 1 }));
    const [chunk] = (await once(socket, "data")) as [Buffer];
    expect(chunk.toString("utf8")).toContain("101 Switching Protocols");

    started.bus.emit({ type: "text_delta", id: "test", text: "hello" });
    const [eventChunk] = (await once(socket, "data")) as [Buffer];
    const events = [...decodeAfterHandshake(chunk), ...decodeServerTextFrames(eventChunk)];

    expect(events.some((event) => event.type === "boot_ready" && event.seq > 1)).toBe(true);
    expect(events.some((event) => event.type === "text_delta" && event.text === "hello")).toBe(true);
    await destroySocket(socket);
  });

  it("fails closed for bad tokens and records a security audit event", async () => {
    const started = await startServer({ port: 0, token: "c".repeat(64), dbPath: ":memory:" });
    servers.push(started);
    const port = new URL(started.url).port;

    const socket = connect(Number(port), "127.0.0.1");
    await once(socket, "connect");
    socket.write(handshake({ port, token: "d".repeat(64) }));
    const [chunk] = (await once(socket, "data")) as [Buffer];

    expect(chunk.toString("utf8")).toContain("403 Forbidden");
    expect(started.bus.replay(undefined).some((event) => event.type === "security_audit" && event.outcome === "denied" && event.reason === "token_invalid")).toBe(true);
    await destroySocket(socket);
  });

  it("rejects hostile Host and Origin headers", async () => {
    const started = await startServer({ port: 0, token: "e".repeat(64), dbPath: ":memory:" });
    servers.push(started);
    const port = new URL(started.url).port;

    const hostSocket = connect(Number(port), "127.0.0.1");
    await once(hostSocket, "connect");
    hostSocket.write(handshake({ port, token: started.token, host: "evil.example" }));
    const [hostChunk] = (await once(hostSocket, "data")) as [Buffer];
    expect(hostChunk.toString("utf8")).toContain("403 Forbidden");
    await destroySocket(hostSocket);

    const originSocket = connect(Number(port), "127.0.0.1");
    await once(originSocket, "connect");
    originSocket.write(handshake({ port, token: started.token, origin: "http://evil.example" }));
    const [originChunk] = (await once(originSocket, "data")) as [Buffer];
    expect(originChunk.toString("utf8")).toContain("403 Forbidden");
    await destroySocket(originSocket);
  });
});

function handshake(options: { port: string; token: string; since?: number; host?: string; origin?: string }): string {
  const since = options.since === undefined ? "" : `&since=${options.since}`;
  return [
    `GET /ws?token=${options.token}${since} HTTP/1.1`,
    `Host: ${options.host ?? `127.0.0.1:${options.port}`}`,
    `Origin: ${options.origin ?? `http://127.0.0.1:${options.port}`}`,
    "Connection: Upgrade",
    "Upgrade: websocket",
    "Sec-WebSocket-Version: 13",
    `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
    "\r\n",
  ].join("\r\n");
}

function decodeAfterHandshake(chunk: Buffer) {
  const marker = "\r\n\r\n";
  const headerEnd = chunk.indexOf(marker);
  if (headerEnd === -1) return [];
  return decodeServerTextFrames(chunk.subarray(headerEnd + marker.length));
}

async function destroySocket(socket: ReturnType<typeof connect>): Promise<void> {
  if (socket.destroyed) return;
  const closed = once(socket, "close");
  socket.destroy();
  await closed;
}
