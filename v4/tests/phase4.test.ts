import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/server/approvals/sessionLeases.js";
import { EventBus } from "../src/server/kernel/eventBus.js";
import { MemoryStore } from "../src/server/memory/memoryStore.js";
import { createLlamaProvider } from "../src/server/offline/llamaProvider.js";
import { StreamingRouter, createMockProvider } from "../src/server/providers/router.js";
import { ToolExecutor } from "../src/server/tools/executor.js";
import { ToolRegistry } from "../src/server/tools/registry.js";
import { TurnEngine } from "../src/server/turns/turnEngine.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "athena-turn-"));
  dirs.push(dir);
  return dir;
}

function engineWith(memory: MemoryStore, workspaceRoot: string) {
  const bus = new EventBus();
  const executor = new ToolExecutor({
    bus,
    tools: new ToolRegistry(),
    approvals: new ApprovalManager(),
    memory,
    recordAudit: async () => undefined,
  });
  const engine = new TurnEngine(bus, {
    executor,
    getExecutionContext: () => ({ workspaceRoot, actor: "interactive", autoApprove: false }),
  });
  return { bus, engine };
}

describe("TurnEngine: offline command surface through the executor", () => {
  it("/tool runs a workspace-scoped tool", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "x.txt"), "hello disk", "utf8");
    const { engine } = engineWith(new MemoryStore(), root);
    expect(await engine.run('/tool read_file {"path":"x.txt"}', "ui")).toContain("hello disk");
  });

  it("/risk classifies without executing", async () => {
    const { engine } = engineWith(new MemoryStore(), await workspace());
    expect(await engine.run("/risk rm -rf /", "ui")).toContain('"tier":2');
  });

  it("/recall returns memory", async () => {
    const memory = new MemoryStore();
    memory.write("athena prefers offline recall for disk issues");
    const { engine } = engineWith(memory, await workspace());
    expect(await engine.run("/recall disk", "ui")).toContain("disk");
  });

  it("falls back to L2 for non-command text", async () => {
    const { engine } = engineWith(new MemoryStore(), await workspace());
    expect(await engine.run("status", "ui")).toContain("kernel");
  });
});

describe("llama provider: SSE streaming", () => {
  function sseResponse(lines: string[], status = 200): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line));
        controller.close();
      },
    });
    return new Response(status === 200 ? body : null, { status });
  }

  it("streams content deltas until stop", async () => {
    const fetchImpl = (async () => sseResponse(['data: {"content":"hel"}\n', 'data: {"content":"lo","stop":false}\n', 'data: {"stop":true}\n'])) as unknown as typeof fetch;
    const provider = createLlamaProvider({ baseUrl: "http://127.0.0.1:8080", fetchImpl });
    let text = "";
    for await (const chunk of provider.stream("hi")) text += chunk.text;
    expect(text).toBe("hello");
  });

  it("fails over to another provider when llama-server is down", async () => {
    const bus = new EventBus();
    const fetchImpl = (async () => sseResponse([], 503)) as unknown as typeof fetch;
    const router = new StreamingRouter([
      createLlamaProvider({ baseUrl: "http://127.0.0.1:8080", fetchImpl }),
      createMockProvider("backup", "mock", ["ok"]),
    ]);
    let text = "";
    for await (const chunk of router.stream("hi", bus)) text += chunk.text;
    expect(text).toBe("ok");
    expect(bus.replay(undefined).some((event) => event.type === "failover")).toBe(true);
  });
});
