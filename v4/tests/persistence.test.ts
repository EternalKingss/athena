import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompositionRoot } from "../src/server/kernel/compositionRoot.js";
import { athenaError } from "../src/shared/errors.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDbPath(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "athena-persist-"));
  dirs.push(dir);
  return path.join(dir, "athena.db");
}

describe("Phase I: state survives a restart", () => {
  it("hydrates memory, coral, instincts, alerts, errors, and audit from disk", async () => {
    const dbPath = await tempDbPath();

    const first = createCompositionRoot({ dbPath, token: "a".repeat(64) });
    await first.init();
    await first.services.writeMemory("athena prefers offline recall for disk failures");
    await first.services.appendCoral("win32", "normalize wsl path separators");
    await first.services.observeInstinct("debug", "check logs first", "s1", 50);
    await first.services.raiseAlert("cpu_spike", "high");
    await first.services.recordAudit({ id: "audit-1", action: "shell_command", outcome: "allowed", autoApproved: false, scopeHash: "deadbeef" });
    await first.repo.insertError({ id: "explicit-err", error: athenaError("probe.err", "test", "error", "persisted error"), createdAt: new Date().toISOString() });
    await first.close();

    const second = createCompositionRoot({ dbPath, token: "a".repeat(64) });
    await second.init();

    expect(second.memory.recall("offline recall disk").length).toBeGreaterThan(0);
    expect(second.coral.pullAtTurnBoundary("win32").length).toBeGreaterThan(0);
    expect(second.watchers.alerts().some((alert) => alert.monitor === "cpu_spike")).toBe(true);
    expect(await second.repo.countInstinctEvents()).toBeGreaterThan(0);
    expect(await second.repo.countAudit()).toBeGreaterThan(0);
    expect(await second.repo.countErrors()).toBeGreaterThan(0);

    await second.close();
  });

  it("persists provider health (including blocks) across a restart", async () => {
    const dbPath = await tempDbPath();

    const first = createCompositionRoot({ dbPath, token: "b".repeat(64) });
    await first.init();
    await first.repo.saveProviderHealth({ provider: "openai", model: "gpt", failureCount: 2, blockedUntil: new Date(Date.now() + 60_000).toISOString() });
    await first.close();

    const second = createCompositionRoot({ dbPath, token: "b".repeat(64) });
    await second.init();
    expect(second.providerHealth.isBlocked({ provider: "openai", model: "gpt" })).toBe(true);
    await second.close();
  });
});
