import { createServer } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { EventBus } from "./kernel/eventBus.js";
import { runBootSelfCheck } from "./kernel/bootSelfCheck.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 48991;

export type ServerOptions = {
  port?: number;
  token?: string;
};

export async function startServer(options: ServerOptions = {}) {
  const port = options.port ?? Number(process.env.ATHENA_V4_PORT ?? DEFAULT_PORT);
  const token = options.token ?? randomBytes(32).toString("hex");
  const bus = new EventBus();

  bus.emit({ type: "boot_started", version: "0.0.0" });
  const selfCheck = await runBootSelfCheck();

  bus.emit({
    type: "capability_changed",
    capability: "sqlite",
    available: selfCheck.sqliteAvailable,
    ...(selfCheck.sqliteAvailable ? {} : { reason: "node:sqlite unavailable" }),
  });
  bus.emit({
    type: "capability_changed",
    capability: "sqlite_fts5",
    available: selfCheck.fts5Available,
    ...(selfCheck.fts5Available ? {} : { reason: "FTS5 probe failed" }),
  });
  bus.emit({ type: "boot_ready" });

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    if (!isAllowedHost(host, port)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    const url = new URL(req.url ?? "/", `http://${host}`);
    if (!isTokenValid(url.searchParams.get("token"), token)) {
      res.writeHead(403).end("forbidden");
      return;
    }

    if (url.pathname === "/events") {
      const since = parseSince(url.searchParams.get("since"));
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(bus.replay(since)));
      return;
    }

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, events: "/events?token=<session>&since=<seq>" }));
  });

  await new Promise<void>((resolve) => server.listen(port, HOST, resolve));
  return { server, bus, token, url: `http://${HOST}:${port}/?token=${token}` };
}

function isAllowedHost(host: string, port: number): boolean {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

function isTokenValid(candidate: string | null, token: string): boolean {
  if (!candidate) return false;
  const left = Buffer.from(candidate, "hex");
  const right = Buffer.from(token, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseSince(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const started = await startServer();
  console.log(started.url);
}
