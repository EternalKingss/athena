import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/server/approvals/sessionLeases.js";
import { EventBus } from "../src/server/kernel/eventBus.js";
import { MemoryStore } from "../src/server/memory/memoryStore.js";
import { ToolExecutor } from "../src/server/tools/executor.js";
import { ToolRegistry } from "../src/server/tools/registry.js";
import type { AuditRecord } from "../src/server/storage/repository.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "athena-ws-"));
  dirs.push(dir);
  return dir;
}

function makeExecutor() {
  const bus = new EventBus();
  const audits: AuditRecord[] = [];
  const executor = new ToolExecutor({
    bus,
    tools: new ToolRegistry(),
    approvals: new ApprovalManager(),
    memory: new MemoryStore(),
    recordAudit: async (record) => {
      audits.push(record);
    },
  });
  return { bus, audits, executor };
}

describe("ToolExecutor: read-only tools", () => {
  it("reads, searches, and hashes within the workspace", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "log.txt"), "line one\nfatal: disk full\nline three", "utf8");
    const { executor } = makeExecutor();
    const ctx = { workspaceRoot: root, actor: "interactive" as const, autoApprove: false };

    expect((await executor.execute("read_file", { path: "log.txt" }, ctx)).output).toContain("disk full");
    expect((await executor.execute("search_text", { path: ".", query: "fatal" }, ctx)).output).toContain("log.txt");
    expect((await executor.execute("hash_file", { path: "log.txt" }, ctx)).output).toMatch(/^[0-9a-f]{64}$/);
  });

  it("blocks path traversal outside the workspace", async () => {
    const root = await workspace();
    const { executor } = makeExecutor();
    const outcome = await executor.execute("read_file", { path: "../../secret" }, { workspaceRoot: root, actor: "interactive", autoApprove: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("escapes workspace");
  });

  it("caps oversized output per manifest", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "big.txt"), "x".repeat(70_000), "utf8");
    const { executor } = makeExecutor();
    const outcome = await executor.execute("read_file", { path: "big.txt" }, { workspaceRoot: root, actor: "interactive", autoApprove: false });
    expect(outcome.capped).toBe(true);
  });
});

describe("ToolExecutor: Tier 2 approval gate", () => {
  it("blocks write_file without approval and does not touch disk", async () => {
    const root = await workspace();
    const { executor, bus, audits } = makeExecutor();
    const outcome = await executor.execute("write_file", { path: "out.txt", content: "nope" }, { workspaceRoot: root, actor: "interactive", autoApprove: false });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("blocked");
    await expect(readFile(path.join(root, "out.txt"), "utf8")).rejects.toThrow();
    expect(bus.replay(undefined).some((event) => event.type === "approval_required")).toBe(true);
    expect(audits.at(-1)?.outcome).toBe("blocked");
  });

  it("allows write_file under interactive AUTO_APPROVE and writes an auto_approved audit row", async () => {
    const root = await workspace();
    const { executor, audits } = makeExecutor();
    const outcome = await executor.execute("write_file", { path: "out.txt", content: "approved" }, { workspaceRoot: root, actor: "interactive", autoApprove: true });
    expect(outcome.ok).toBe(true);
    expect(await readFile(path.join(root, "out.txt"), "utf8")).toBe("approved");
    expect(audits.at(-1)).toMatchObject({ outcome: "allowed", autoApproved: true });
  });

  it("never lets a background agent pass Tier 2, even with AUTO_APPROVE", async () => {
    const root = await workspace();
    const { executor } = makeExecutor();
    const outcome = await executor.execute("write_file", { path: "out.txt", content: "x" }, { workspaceRoot: root, actor: "background", autoApprove: true });
    expect(outcome.ok).toBe(false);
    await expect(readFile(path.join(root, "out.txt"), "utf8")).rejects.toThrow();
  });
});

describe("ToolExecutor: shell_command through the risk engine", () => {
  it("blocks a Tier 2 destructive command without approval", async () => {
    const root = await workspace();
    const { executor } = makeExecutor();
    const outcome = await executor.execute("shell_command", { command: "rm -rf /" }, { workspaceRoot: root, actor: "interactive", autoApprove: false });
    expect(outcome.tier).toBe(2);
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toContain("blocked");
  });

  it("runs a benign command and emits lifecycle events", async () => {
    const root = await workspace();
    const { executor, bus } = makeExecutor();
    const outcome = await executor.execute("shell_command", { command: "node --version" }, { workspaceRoot: root, actor: "interactive", autoApprove: false });
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toMatch(/v\d+/);
    const types = bus.replay(undefined).map((event) => event.type);
    expect(types).toContain("tool_started");
    expect(types).toContain("tool_output");
    expect(types).toContain("tool_finished");
  });
});
