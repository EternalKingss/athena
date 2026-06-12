import { createServer } from "node:http";
import { totalmem } from "node:os";
import { runBootSelfCheck } from "./kernel/bootSelfCheck.js";
import { createCompositionRoot } from "./kernel/compositionRoot.js";
import { offlineMode, selectLocalModel } from "./offline/localModel.js";
import { buildCloudProviders } from "./providers/cloudProviders.js";
import { attachWebSocketTransport, isAllowedHost } from "./transport/webSocket.js";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 48991;

export type ServerOptions = {
  port?: number;
  token?: string;
  dbPath?: string;
};

export async function startServer(options: ServerOptions = {}) {
  let port = options.port ?? Number(process.env.ATHENA_V4_PORT ?? DEFAULT_PORT);
  const llamaBaseUrl = process.env.ATHENA_LLAMA_URL;
  const workspaceRoot = process.env.ATHENA_WORKSPACE;
  const root = createCompositionRoot({
    providers: buildCloudProviders(),
    ...(options.token === undefined ? {} : { token: options.token }),
    ...(options.dbPath === undefined ? {} : { dbPath: options.dbPath }),
    ...(llamaBaseUrl === undefined ? {} : { llamaBaseUrl }),
    ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
  });
  const { bus, token } = root;

  bus.emit({ type: "boot_started", version: "0.0.0" });
  const selfCheck = await runBootSelfCheck();
  await root.init();

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
  const hasApiKeys = Boolean(process.env.ATHENA_OPENAI_KEY ?? process.env.OPENAI_API_KEY ?? process.env.ANTHROPIC_API_KEY);
  const hasNetwork = process.env.ATHENA_OFFLINE !== "1";
  const mode = offlineMode(hasNetwork, hasApiKeys);
  bus.emit({ type: "mode_changed", mode, reason: mode === "offline" ? "no network or no API keys" : "cloud providers configured" });

  const localChoice = selectLocalModel(Math.max(1, Math.round(totalmem() / 1024 ** 3)));
  bus.emit({
    type: "capability_changed",
    capability: "local_llm",
    available: llamaBaseUrl !== undefined,
    ...(llamaBaseUrl === undefined ? { reason: `set ATHENA_LLAMA_URL to a vendored llama-server (suggested model ${localChoice.id})` } : {}),
  });

  bus.emit({ type: "boot_ready" });

  const server = createServer((req, res) => {
    const host = req.headers.host ?? "";
    if (!isAllowedHost(host, port)) {
      const audit = auditRow("http_request", "denied", "host_not_allowed", req.socket.remoteAddress);
      bus.emit({ type: "security_audit", ...audit });
      void root.db.writeSecurityAudit(audit);
      res.writeHead(403).end("forbidden");
      return;
    }

    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: true, ws: "/ws?token=<session>&since=<seq>" }));
  });
  const transport = attachWebSocketTransport(server, {
    bus,
    db: root.db,
    token,
    getPort: () => port,
    onClientEvent: async (event) => {
      if (event.type === "chat_submit") await root.turnEngine.run(event.text, "ui");
      else if (event.type === "approval_response") root.approvalBroker.resolve(event.id, event.approved, event.forSession ?? false);
      else if (event.type === "set_auto_approve") root.setAutoApprove(event.enabled);
    },
  });

  await new Promise<void>((resolve) => server.listen(port, HOST, resolve));
  const address = server.address();
  if (typeof address === "object" && address) port = address.port;
  const close = async () => {
    transport.close();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    await root.close();
  };
  return { server, bus, token, url: `http://${HOST}:${port}/?token=${token}`, close };
}

function auditRow(action: "http_request", outcome: "denied", reason: string, remoteAddress: string | undefined) {
  return {
    action,
    outcome,
    reason,
    ...(remoteAddress === undefined ? {} : { remoteAddress }),
  };
}

if (process.argv[1]?.endsWith("server.js")) {
  const started = await startServer();
  console.log(started.url);
}
