import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalManager } from "../src/server/approvals/sessionLeases.js";
import { EventBus } from "../src/server/kernel/eventBus.js";
import { MemoryStore } from "../src/server/memory/memoryStore.js";
import { ProviderHealth } from "../src/server/providers/providerHealth.js";
import { SkillRegistry } from "../src/server/skills/skillTrust.js";
import { ToolExecutor } from "../src/server/tools/executor.js";
import { ToolRegistry } from "../src/server/tools/registry.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "athena-h-"));
  dirs.push(dir);
  return dir;
}

function makeExecutor() {
  const bus = new EventBus();
  const memory = new MemoryStore();
  const providerHealth = new ProviderHealth();
  const skills = new SkillRegistry();
  const ackAlert = vi.fn(async () => undefined);
  const executor = new ToolExecutor({
    bus,
    tools: new ToolRegistry(),
    approvals: new ApprovalManager(),
    memory,
    providerHealth,
    skills,
    recordAudit: async () => undefined,
    writeMemory: async (body) => memory.write(body),
    ackAlert,
  });
  return { bus, memory, providerHealth, skills, ackAlert, executor };
}

const interactive = { actor: "interactive" as const, autoApprove: false };

describe("diagnostic handlers", () => {
  it("procs lists running processes", async () => {
    const { executor } = makeExecutor();
    const outcome = await executor.execute("procs", {}, { workspaceRoot: process.cwd(), ...interactive });
    expect(outcome.ok).toBe(true);
    expect(outcome.output.length).toBeGreaterThan(0);
  });

  it("log_tail merges tails of scoped files", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "a.log"), "a1\na2\na3", "utf8");
    await writeFile(path.join(root, "b.log"), "b1\nb2", "utf8");
    const { executor } = makeExecutor();
    const outcome = await executor.execute("log_tail", { paths: ["a.log", "b.log"], lines: 2 }, { workspaceRoot: root, ...interactive });
    expect(outcome.output).toContain("a.log");
    expect(outcome.output).toContain("b.log");
    expect(outcome.output).toContain("a3");
  });

  it("net_debug returns structured timings (closed port -> -1 tcp)", async () => {
    const { executor } = makeExecutor();
    const outcome = await executor.execute("net_debug", { host: "127.0.0.1", port: 1 }, { workspaceRoot: process.cwd(), ...interactive });
    expect(outcome.ok).toBe(true);
    expect(outcome.output).toContain("127.0.0.1");
    expect(outcome.output).toContain("tcpMs");
  });

  it("provider_test reports health snapshot", async () => {
    const { executor, providerHealth } = makeExecutor();
    providerHealth.recordFailure({ provider: "openai", model: "gpt" }, 429);
    const outcome = await executor.execute("provider_test", {}, { workspaceRoot: process.cwd(), ...interactive });
    expect(outcome.output).toContain("openai");
  });
});

describe("memory, skills, and watcher handlers", () => {
  it("memory_write is blocked by prohibited patterns", async () => {
    const { executor, memory } = makeExecutor();
    memory.addProhibitedPattern("password");
    expect((await executor.execute("memory_write", { body: "remember the password is hunter2" }, { workspaceRoot: process.cwd(), ...interactive })).ok).toBe(false);
    expect((await executor.execute("memory_write", { body: "the disk fills under heavy logging" }, { workspaceRoot: process.cwd(), ...interactive })).ok).toBe(true);
  });

  it("skill_load enforces the trust gate until promotion", async () => {
    const root = process.cwd();
    const { executor, skills } = makeExecutor();
    skills.saveUnverified("repair-node", "steps");
    expect((await executor.execute("skill_load", { name: "repair-node" }, { workspaceRoot: root, ...interactive })).output).toBe("tier2_unverified_skill_gate");
    const promote = await executor.execute("skill_promote", { name: "repair-node" }, { workspaceRoot: root, actor: "interactive", autoApprove: true });
    expect(promote.ok).toBe(true);
    expect((await executor.execute("skill_load", { name: "repair-node" }, { workspaceRoot: root, ...interactive })).ok).toBe(true);
  });

  it("watcher_ack routes to the alert transition", async () => {
    const { executor, ackAlert } = makeExecutor();
    const outcome = await executor.execute("watcher_ack", { id: "alert-1" }, { workspaceRoot: process.cwd(), ...interactive });
    expect(outcome.ok).toBe(true);
    expect(ackAlert).toHaveBeenCalledWith("alert-1");
  });
});
