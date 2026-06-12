import { Worker } from "node:worker_threads";
import { ATHENA_FTS_SQL, ATHENA_SCHEMA_SQL } from "../storage/schema.js";

export type DbWorkerMessage =
  | { id: number; type: "ping" }
  | {
      id: number;
      type: "writeSecurityAudit";
      row: { action: string; outcome: string; reason: string; remoteAddress?: string };
    }
  | { id: number; type: "close" };

type DbWorkerRequest =
  | { type: "ping" }
  | { type: "writeSecurityAudit"; row: { action: string; outcome: string; reason: string; remoteAddress?: string } }
  | { type: "close" };

export type DbWorkerOptions = {
  dbPath?: string;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

export class DbWorker {
  #nextId = 1;
  #pending = new Map<number, PendingRequest>();
  #worker: Worker;

  constructor(options: DbWorkerOptions = {}) {
    this.#worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { dbPath: options.dbPath ?? "data/athena.db", schemaSql: ATHENA_SCHEMA_SQL, ftsSql: ATHENA_FTS_SQL },
    });
    this.#worker.on("message", (message: unknown) => this.#handleMessage(message));
    this.#worker.on("error", (error: Error) => this.#rejectAll(error));
    this.#worker.on("exit", (code) => {
      if (code !== 0) this.#rejectAll(new Error(`DB worker exited with code ${code}`));
    });
  }

  ping(): Promise<{ ok: true }> {
    return this.#request<{ ok: true }>({ type: "ping" });
  }

  writeSecurityAudit(row: { action: string; outcome: string; reason: string; remoteAddress?: string }): Promise<void> {
    return this.#request({ type: "writeSecurityAudit", row }).then(() => undefined);
  }

  async close(): Promise<void> {
    await this.#request({ type: "close" });
    await this.#worker.terminate();
  }

  #request<T = unknown>(message: DbWorkerRequest): Promise<T> {
    const id = this.#nextId++;
    const payload = { ...message, id } as DbWorkerMessage;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.#worker.postMessage(payload);
    });
  }

  #handleMessage(message: unknown): void {
    if (!isWorkerReply(message)) return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok) {
      pending.resolve(message.value);
    } else {
      pending.reject(new Error(message.error));
    }
  }

  #rejectAll(error: Error): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }
}

function isWorkerReply(message: unknown): message is { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string } {
  return typeof message === "object" && message !== null && "id" in message && "ok" in message;
}

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { mkdirSync } = require("node:fs");
const { dirname } = require("node:path");
let db;

async function open() {
  if (db) return db;
  if (workerData.dbPath !== ":memory:") {
    mkdirSync(dirname(workerData.dbPath), { recursive: true });
  }
  const sqlite = await import("node:sqlite");
  db = new sqlite.DatabaseSync(workerData.dbPath);
  db.exec(workerData.schemaSql);
  try {
    db.exec(workerData.ftsSql);
  } catch {
    db.exec("INSERT OR REPLACE INTO settings (key, value) VALUES ('sqlite_fts5', 'unavailable')");
  }
  db.exec("CREATE TABLE IF NOT EXISTS security_audit (id INTEGER PRIMARY KEY, ts TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, reason TEXT NOT NULL, remote_address TEXT)");
  return db;
}

parentPort.on("message", async (message) => {
  try {
    if (message.type === "ping") {
      await open();
      parentPort.postMessage({ id: message.id, ok: true, value: { ok: true } });
      return;
    }
    if (message.type === "writeSecurityAudit") {
      const database = await open();
      database.prepare("INSERT INTO security_audit (ts, action, outcome, reason, remote_address) VALUES (?, ?, ?, ?, ?)").run(
        new Date().toISOString(),
        message.row.action,
        message.row.outcome,
        message.row.reason,
        message.row.remoteAddress ?? null
      );
      parentPort.postMessage({ id: message.id, ok: true });
      return;
    }
    if (message.type === "close") {
      if (db) db.close();
      parentPort.postMessage({ id: message.id, ok: true });
      return;
    }
    throw new Error("Unknown DB worker message");
  } catch (error) {
    parentPort.postMessage({ id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
});
`;
