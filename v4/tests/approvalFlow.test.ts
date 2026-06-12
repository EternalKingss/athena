import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCompositionRoot } from "../src/server/kernel/compositionRoot.js";
import type { ServerEvent } from "../src/shared/events.js";

const dirs: string[] = [];
const roots: Array<Awaited<ReturnType<typeof createCompositionRoot>>> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await root.close();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function freshRoot() {
  const ws = await mkdtemp(path.join(tmpdir(), "athena-appr-"));
  dirs.push(ws);
  const root = createCompositionRoot({ dbPath: ":memory:", workspaceRoot: ws, token: "a".repeat(64) });
  roots.push(root);
  await root.init();
  return { root, ws };
}

function pendingApprovalId(root: Awaited<ReturnType<typeof createCompositionRoot>>): string {
  const event = root.bus.replay(undefined).find((candidate) => candidate.type === "approval_required");
  return (event as Extract<ServerEvent, { type: "approval_required" }>).id;
}

const ctx = (ws: string, autoApprove = false) => ({ workspaceRoot: ws, actor: "interactive" as const, autoApprove });

describe("async Tier 2 approval flow", () => {
  it("proceeds when the user approves over the wire", async () => {
    const { root, ws } = await freshRoot();
    const pending = root.executor.execute("write_file", { path: "out.txt", content: "approved-via-ui" }, ctx(ws));
    const resolved = root.approvalBroker.resolve(pendingApprovalId(root), true, false);
    expect(resolved).toBe(true);
    const outcome = await pending;
    expect(outcome.ok).toBe(true);
    expect(await readFile(path.join(ws, "out.txt"), "utf8")).toBe("approved-via-ui");
  });

  it("blocks when the user denies, leaving disk untouched", async () => {
    const { root, ws } = await freshRoot();
    const pending = root.executor.execute("write_file", { path: "out.txt", content: "nope" }, ctx(ws));
    root.approvalBroker.resolve(pendingApprovalId(root), false);
    const outcome = await pending;
    expect(outcome.ok).toBe(false);
    await expect(readFile(path.join(ws, "out.txt"), "utf8")).rejects.toThrow();
  });

  it("auto-approves interactive Tier 2 without prompting when AUTO_APPROVE is on", async () => {
    const { root, ws } = await freshRoot();
    const outcome = await root.executor.execute("write_file", { path: "out.txt", content: "auto" }, ctx(ws, true));
    expect(outcome.ok).toBe(true);
    expect(root.bus.replay(undefined).some((event) => event.type === "approval_required")).toBe(false);
    expect(await readFile(path.join(ws, "out.txt"), "utf8")).toBe("auto");
  });
});
