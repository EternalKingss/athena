import { exec } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import type { RiskTier } from "../../shared/events.js";
import { AthenaRuntimeError, athenaError } from "../../shared/errors.js";
import type { ApprovalBroker } from "../approvals/approvalBroker.js";
import { ApprovalManager, type ApprovalLease, hashScope } from "../approvals/sessionLeases.js";
import { parseStacktrace, summarizeNetDebug } from "../debug/debugTools.js";
import type { EventBus } from "../kernel/eventBus.js";
import type { MemoryStore } from "../memory/memoryStore.js";
import type { ProviderHealth } from "../providers/providerHealth.js";
import { classifyCommand } from "../risk/riskEngine.js";
import type { SkillRegistry } from "../skills/skillTrust.js";
import type { AuditRecord } from "../storage/repository.js";
import { ToolRegistry } from "./registry.js";

const execAsync = promisify(exec);
const SHELL_TIMEOUT_MS = 15_000;
const MAX_SHELL_BUFFER = 1024 * 1024;
const MAX_SEARCH_FILES = 2_000;

export type ExecutionContext = {
  workspaceRoot: string;
  actor: "interactive" | "background";
  autoApprove: boolean;
};

export type ToolInput = Record<string, unknown>;

export type ToolOutcome = {
  ok: boolean;
  output: string;
  tier: RiskTier;
  capped: boolean;
};

type Handler = (input: ToolInput, ctx: ExecutionContext) => Promise<{ ok: boolean; output: string }>;

export type ToolExecutorDeps = {
  bus: EventBus;
  tools: ToolRegistry;
  approvals: ApprovalManager;
  memory: MemoryStore;
  recordAudit: (record: AuditRecord) => Promise<void>;
  approvalBroker?: ApprovalBroker;
  providerHealth?: ProviderHealth;
  skills?: SkillRegistry;
  writeMemory?: (body: string) => Promise<{ action: string }>;
  ackAlert?: (id: string) => Promise<unknown>;
};

/**
 * Runs a tool through the full security pipeline: resolve tier (risk engine for
 * shell), gate Tier 2 on approval, execute the handler, cap output per manifest,
 * and emit tool_started / tool_output / tool_finished plus an audit row.
 */
export class ToolExecutor {
  #handlers: Record<string, Handler>;

  constructor(private readonly deps: ToolExecutorDeps) {
    this.#handlers = {
      read_file: async (input, ctx) => ({ ok: true, output: await readFile(resolveInside(ctx.workspaceRoot, str(input.path)), "utf8") }),
      list_dir: async (input, ctx) => {
        const entries = await readdir(resolveInside(ctx.workspaceRoot, str(input.path, ".")), { withFileTypes: true });
        return { ok: true, output: entries.map((entry) => `${entry.isDirectory() ? "d" : "-"} ${entry.name}`).join("\n") };
      },
      stat_path: async (input, ctx) => {
        const info = await stat(resolveInside(ctx.workspaceRoot, str(input.path)));
        return { ok: true, output: JSON.stringify({ size: info.size, isDirectory: info.isDirectory(), modified: info.mtime.toISOString() }) };
      },
      hash_file: async (input, ctx) => ({ ok: true, output: createHash("sha256").update(await readFile(resolveInside(ctx.workspaceRoot, str(input.path)))).digest("hex") }),
      search_text: async (input, ctx) => ({ ok: true, output: await searchText(resolveInside(ctx.workspaceRoot, str(input.path, ".")), str(input.query)) }),
      parse_stacktrace: async (input) => ({ ok: true, output: JSON.stringify(parseStacktrace(str(input.text))) }),
      memory_recall: async (input) => ({ ok: true, output: this.deps.memory.recall(str(input.query)).map((entry) => entry.body).join("\n") }),
      procs: async () => ({ ok: true, output: await listProcesses() }),
      log_tail: async (input, ctx) => ({ ok: true, output: await tailLogs(ctx.workspaceRoot, input) }),
      net_debug: async (input) => {
        const host = str(input.host);
        if (host.length === 0) return { ok: false, output: "host required" };
        const port = typeof input.port === "number" ? input.port : 443;
        return { ok: true, output: JSON.stringify(await netDebug(host, port)) };
      },
      provider_test: async () => ({ ok: true, output: JSON.stringify(this.deps.providerHealth?.snapshot() ?? []) }),
      memory_write: async (input) => {
        const body = str(input.body);
        const result = this.deps.writeMemory ? await this.deps.writeMemory(body) : this.deps.memory.write(body);
        return { ok: true, output: `memory ${result.action}` };
      },
      skill_load: async (input, ctx) => {
        if (!this.deps.skills) return { ok: false, output: "skills unavailable" };
        const decision = this.deps.skills.load(str(input.name), ctx.actor);
        return { ok: decision.allowed, output: decision.reason };
      },
      skill_promote: async (input) => {
        if (!this.deps.skills) return { ok: false, output: "skills unavailable" };
        return { ok: true, output: `promoted ${this.deps.skills.promote(str(input.name)).name}` };
      },
      watcher_ack: async (input) => {
        if (!this.deps.ackAlert) return { ok: false, output: "watchers unavailable" };
        await this.deps.ackAlert(str(input.id));
        return { ok: true, output: `acked ${str(input.id)}` };
      },
      write_file: async (input, ctx) => {
        const file = resolveInside(ctx.workspaceRoot, str(input.path));
        await mkdir(path.dirname(file), { recursive: true });
        const content = str(input.content);
        await writeFile(file, content, "utf8");
        return { ok: true, output: `wrote ${Buffer.byteLength(content, "utf8")} bytes to ${str(input.path)}` };
      },
      patch_file: async (input, ctx) => {
        const file = resolveInside(ctx.workspaceRoot, str(input.path));
        const find = str(input.find);
        const text = await readFile(file, "utf8");
        if (find.length === 0 || !text.includes(find)) return { ok: false, output: "patch target not found" };
        await writeFile(file, text.replace(find, str(input.replace)), "utf8");
        return { ok: true, output: `patched ${str(input.path)}` };
      },
      delete_file: async (input, ctx) => {
        await rm(resolveInside(ctx.workspaceRoot, str(input.path)), { force: true });
        return { ok: true, output: `deleted ${str(input.path)}` };
      },
      shell_command: async (input, ctx) => runShell(str(input.command), ctx.workspaceRoot),
    };
  }

  /** Tool names that have a real handler (for the agent loop's tool catalog). */
  implemented(): string[] {
    return Object.keys(this.#handlers);
  }

  async execute(name: string, input: ToolInput, ctx: ExecutionContext): Promise<ToolOutcome> {
    const id = randomUUID();
    const manifest = this.deps.tools.get(name);
    if (!manifest) {
      this.deps.bus.emit({ type: "error_detail", error: athenaError("tool.unknown", "tools", "error", `Unknown tool: ${name}`) });
      return { ok: false, output: `unknown tool: ${name}`, tier: 0, capped: false };
    }

    const command = name === "shell_command" ? str(input.command) : undefined;
    const tier: RiskTier = command === undefined ? manifest.defaultTier : classifyCommand(command).tier;
    this.deps.bus.emit({ type: "tool_started", id, name, tier });

    if (tier >= 2) {
      const scope = command ?? `${name}:${JSON.stringify(input)}`;
      const preview = (command ?? JSON.stringify(input)).slice(0, 200);
      let decision = this.deps.approvals.decide(scope, 2, { actor: ctx.actor, autoApprove: ctx.autoApprove });

      // Interactive action with no standing lease: ask the UI and wait (fails closed on timeout).
      if (!decision.allowed && decision.reason === "explicit_approval_required" && this.deps.approvalBroker) {
        this.deps.bus.emit({ type: "approval_required", id, tool: name, reason: "awaiting_user_approval", preview });
        const response = await this.deps.approvalBroker.request(id);
        if (response.approved) {
          const lease: ApprovalLease | undefined = response.forSession ? this.deps.approvals.grant(scope) : undefined;
          decision = { allowed: true, reason: response.forSession ? "user_approved_session" : "user_approved_once", ...(lease ? { lease } : {}) };
        } else {
          decision = { allowed: false, reason: "user_denied" };
        }
        this.deps.bus.emit({ type: "approval_resolved", id, approved: response.approved, ...(decision.lease ? { grantId: decision.lease.id } : {}) });
      }

      await this.deps.recordAudit({
        id: randomUUID(),
        action: name,
        outcome: decision.allowed ? "allowed" : "blocked",
        autoApproved: decision.lease?.autoApproved ?? false,
        scopeHash: hashScope(scope),
        reason: decision.reason,
      });
      if (!decision.allowed) {
        if (!this.deps.approvalBroker) this.deps.bus.emit({ type: "approval_required", id, tool: name, reason: decision.reason, preview });
        this.deps.bus.emit({ type: "tool_finished", id, ok: false, bytes: 0 });
        return { ok: false, output: `blocked: ${decision.reason}`, tier, capped: false };
      }
    }

    const handler = this.#handlers[name];
    if (!handler) {
      this.deps.bus.emit({ type: "tool_finished", id, ok: false, bytes: 0 });
      return { ok: false, output: `not implemented: ${name}`, tier, capped: false };
    }

    let raw: { ok: boolean; output: string };
    try {
      raw = await handler(input, ctx);
    } catch (error) {
      const detail = error instanceof AthenaRuntimeError ? error.detail : athenaError("tool.failed", "tools", "error", error instanceof Error ? error.message : String(error));
      this.deps.bus.emit({ type: "error_detail", error: detail });
      this.deps.bus.emit({ type: "tool_finished", id, ok: false, bytes: 0 });
      return { ok: false, output: detail.message, tier, capped: false };
    }

    const capped = this.deps.tools.capOutput(name, raw.output);
    this.deps.bus.emit({ type: "tool_output", id, name, bytes: capped.bytes, capped: capped.capped });
    this.deps.bus.emit({ type: "tool_finished", id, ok: raw.ok, bytes: capped.bytes });
    return { ok: raw.ok, output: capped.output, tier, capped: capped.capped };
  }
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function resolveInside(root: string, target: string): string {
  const normalizedRoot = path.resolve(root);
  const resolved = path.resolve(normalizedRoot, target);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw new AthenaRuntimeError(athenaError("tool.path_escape", "tools", "error", `Path escapes workspace: ${target}`, "Tools are scoped to the workspace root."));
  }
  return resolved;
}

async function runShell(command: string, cwd: string): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(command, { cwd, timeout: SHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: MAX_SHELL_BUFFER });
    return { ok: true, output: combine(stdout, stderr) };
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: combine(failure.stdout ?? "", failure.stderr ?? failure.message ?? "command failed") };
  }
}

function combine(stdout: string, stderr: string): string {
  return stderr.length > 0 ? `${stdout}${stdout.length > 0 ? "\n" : ""}[stderr] ${stderr}`.trim() : stdout.trim();
}

async function listProcesses(): Promise<string> {
  const command = process.platform === "win32" ? "tasklist" : "ps -eo pid,pcpu,pmem,comm";
  const result = await runShell(command, process.cwd());
  return result.output;
}

async function tailLogs(workspaceRoot: string, input: ToolInput): Promise<string> {
  const paths = Array.isArray(input.paths) ? input.paths.filter((value): value is string => typeof value === "string") : [];
  const lines = typeof input.lines === "number" ? input.lines : 200;
  const out: string[] = [];
  for (const relative of paths) {
    try {
      const text = await readFile(resolveInside(workspaceRoot, relative), "utf8");
      out.push(`== ${relative} ==`, ...text.split(/\r?\n/).slice(-lines));
    } catch {
      out.push(`== ${relative} == (unreadable)`);
    }
  }
  return out.join("\n");
}

async function netDebug(host: string, port: number): Promise<ReturnType<typeof summarizeNetDebug>> {
  const dnsStart = performance.now();
  let address = host;
  try {
    address = (await dnsLookup(host)).address;
  } catch {
    // unresolved host: fall through and let the TCP attempt report the failure
  }
  const dnsMs = Math.round(performance.now() - dnsStart);

  const tcpStart = performance.now();
  const tcpMs = await new Promise<number>((resolve) => {
    const socket = netConnect({ host: address, port });
    const finish = (value: number) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(5_000);
    socket.once("connect", () => finish(Math.round(performance.now() - tcpStart)));
    socket.once("timeout", () => finish(-1));
    socket.once("error", () => finish(-1));
  });

  return summarizeNetDebug(host, { dnsMs, tcpMs });
}

async function searchText(root: string, query: string): Promise<string> {
  if (query.length === 0) return "";
  const matches: string[] = [];
  let scanned = 0;
  const stack: string[] = [root];
  while (stack.length > 0 && scanned < MAX_SEARCH_FILES) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        stack.push(full);
      } else if (entry.isFile()) {
        scanned += 1;
        let text;
        try {
          text = await readFile(full, "utf8");
        } catch {
          continue;
        }
        text.split(/\r?\n/).forEach((line, index) => {
          if (line.includes(query)) matches.push(`${path.relative(root, full)}:${index + 1}: ${line.trim()}`);
        });
      }
    }
  }
  return matches.join("\n");
}
