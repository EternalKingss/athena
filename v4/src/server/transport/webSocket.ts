import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ClientEvent, EventSeq, ServerEvent } from "../../shared/events.js";
import { athenaError } from "../../shared/errors.js";
import type { DbWorker } from "../kernel/dbWorker.js";
import type { EventBus } from "../kernel/eventBus.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_INBOUND_BYTES = 1024 * 1024;

export type WebSocketTransportOptions = {
  bus: EventBus;
  db: DbWorker;
  token: string;
  getPort: () => number;
  onClientEvent?: (event: ClientEvent) => void | Promise<void>;
};

export type WebSocketTransport = {
  close: () => void;
};

export function attachWebSocketTransport(server: Server, options: WebSocketTransportOptions): WebSocketTransport {
  const sockets = new Set<Duplex>();
  server.on("upgrade", (req, socket) => {
    void handleUpgrade(req, socket, options, sockets);
  });
  return {
    close: () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      sockets.clear();
    },
  };
}

async function handleUpgrade(req: IncomingMessage, socket: Duplex, options: WebSocketTransportOptions, sockets: Set<Duplex>): Promise<void> {
  const host = req.headers.host ?? "";
  const url = new URL(req.url ?? "/", `http://${host}`);
  const remoteAddress = req.socket.remoteAddress;
  const denied = (reason: string) => {
    const audit = auditRow("denied", reason, remoteAddress);
    options.bus.emit({ type: "security_audit", ...audit });
    void options.db.writeSecurityAudit(audit);
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
  };

  if (url.pathname !== "/ws") {
    denied("unknown_upgrade_path");
    return;
  }
  if (!isAllowedHost(host, options.getPort())) {
    denied("host_not_allowed");
    return;
  }
  if (!isAllowedOrigin(req.headers.origin, options.getPort())) {
    denied("origin_not_allowed");
    return;
  }
  if (!isTokenValid(url.searchParams.get("token"), options.token)) {
    denied("token_invalid");
    return;
  }
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
    denied("bad_websocket_handshake");
    return;
  }

  const audit = auditRow("allowed", "authenticated_loopback", remoteAddress);
  options.bus.emit({ type: "security_audit", ...audit });
  void options.db.writeSecurityAudit(audit);

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      "\r\n",
    ].join("\r\n"),
  );

  sockets.add(socket);
  const since = parseSince(url.searchParams.get("since"));
  for (const event of options.bus.replay(since)) {
    writeTextFrame(socket, JSON.stringify(event));
  }
  const unsubscribe = options.bus.subscribe((event) => writeTextFrame(socket, JSON.stringify(event)));
  const cleanup = () => {
    unsubscribe();
    sockets.delete(socket);
  };
  socket.on("close", cleanup);
  socket.on("error", cleanup);

  // TCP can split or coalesce frames, so accumulate and only consume whole frames.
  let inbound = Buffer.alloc(0);
  socket.on("data", (chunk: Buffer) => {
    inbound = inbound.length === 0 ? Buffer.from(chunk) : Buffer.concat([inbound, chunk]);
    const { frames, consumed } = readClientFrames(inbound);
    inbound = consumed >= inbound.length ? Buffer.alloc(0) : Buffer.from(inbound.subarray(consumed));
    if (inbound.length > MAX_INBOUND_BYTES) {
      socket.destroy();
      return;
    }
    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        unsubscribe();
        socket.end(encodeFrame(Buffer.alloc(0), 0x8));
      } else if (frame.opcode === 0x9) {
        socket.write(encodeFrame(frame.payload, 0xa));
      } else if (frame.opcode === 0x1 && options.onClientEvent) {
        const parsed = parseClientEvent(frame.payload);
        if (parsed === undefined) {
          options.bus.emit({ type: "error_detail", error: athenaError("transport.bad_frame", "transport", "warning", "Unparseable client frame ignored") });
          continue;
        }
        void Promise.resolve(options.onClientEvent(parsed)).catch((error: unknown) => {
          options.bus.emit({
            type: "error_detail",
            error: athenaError("transport.client_event_failed", "transport", "error", error instanceof Error ? error.message : String(error)),
          });
        });
      }
    }
  });
}

function parseClientEvent(payload: Buffer): ClientEvent | undefined {
  try {
    const parsed = JSON.parse(payload.toString("utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null && "type" in parsed) return parsed as ClientEvent;
    return undefined;
  } catch {
    return undefined;
  }
}

export function isAllowedHost(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function isTokenValid(candidate: string | null, token: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate, "hex");
  const right = Buffer.from(token, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function acceptKey(key: string): string {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function parseSince(value: string | null): EventSeq | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function writeTextFrame(socket: Duplex, text: string): void {
  socket.write(encodeFrame(Buffer.from(text, "utf8"), 0x1));
}

function encodeFrame(payload: Buffer, opcode: number): Buffer {
  const headerLength = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
  const frame = Buffer.alloc(headerLength + payload.length);
  frame[0] = 0x80 | opcode;
  if (payload.length < 126) {
    frame[1] = payload.length;
  } else if (payload.length <= 0xffff) {
    frame[1] = 126;
    frame.writeUInt16BE(payload.length, 2);
  } else {
    frame[1] = 127;
    frame.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  payload.copy(frame, headerLength);
  return frame;
}

function readClientFrames(chunk: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; consumed: number } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const frameStart = offset;
    const opcode = chunk[offset]! & 0x0f;
    const masked = (chunk[offset + 1]! & 0x80) !== 0;
    let length = chunk[offset + 1]! & 0x7f;
    offset += 2;
    if (length === 126) {
      if (offset + 2 > chunk.length) {
        offset = frameStart;
        break;
      }
      length = chunk.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > chunk.length) {
        offset = frameStart;
        break;
      }
      const wideLength = chunk.readBigUInt64BE(offset);
      if (wideLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        offset = frameStart;
        break;
      }
      length = Number(wideLength);
      offset += 8;
    }
    // Client frames must be masked; an incomplete frame waits for the next chunk.
    if (!masked || offset + 4 + length > chunk.length) {
      offset = frameStart;
      break;
    }
    const mask = chunk.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = chunk[offset + index]! ^ mask[index % 4]!;
    }
    offset += length;
    frames.push({ opcode, payload });
  }
  return { frames, consumed: offset };
}

export function decodeServerTextFrames(chunk: Buffer): ServerEvent[] {
  const events: ServerEvent[] = [];
  let offset = 0;
  while (offset + 2 <= chunk.length) {
    const opcode = chunk[offset]! & 0x0f;
    let length = chunk[offset + 1]! & 0x7f;
    offset += 2;
    if (length === 126) {
      length = chunk.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      length = Number(chunk.readBigUInt64BE(offset));
      offset += 8;
    }
    if (offset + length > chunk.length) break;
    const payload = chunk.subarray(offset, offset + length);
    offset += length;
    if (opcode === 0x1) events.push(JSON.parse(payload.toString("utf8")) as ServerEvent);
  }
  return events;
}

function auditRow(outcome: "allowed" | "denied", reason: string, remoteAddress: string | undefined) {
  return {
    action: "ws_connect" as const,
    outcome,
    reason,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  };
}
