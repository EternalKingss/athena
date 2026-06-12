import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/server/approvals/sessionLeases.js";
import { EventBus } from "../src/server/kernel/eventBus.js";
import { MemoryStore } from "../src/server/memory/memoryStore.js";
import { StreamingRouter, type ChatProvider } from "../src/server/providers/router.js";
import { ToolExecutor } from "../src/server/tools/executor.js";
import { ToolRegistry } from "../src/server/tools/registry.js";
import { AgentLoop } from "../src/server/turns/agentLoop.js";

const dirs: string[] = [];

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function workspace(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "athena-agent-"));
  dirs.push(dir);
  return dir;
}

function scripted(responses: string[]): ChatProvider {
  let index = 0;
  return {
    provider: "mock",
    model: "m",
    async *stream() {
      const response = responses[Math.min(index, responses.length - 1)] ?? "";
      index += 1;
      yield { text: response };
    },
  };
}

function loopWith(responses: string[], workspaceRoot: string) {
  const bus = new EventBus();
  const executor = new ToolExecutor({
    bus,
    tools: new ToolRegistry(),
    approvals: new ApprovalManager(),
    memory: new MemoryStore(),
    recordAudit: async () => undefined,
  });
  const router = new StreamingRouter([scripted(responses)]);
  return { bus, agent: new AgentLoop({ bus, router, executor }) };
}

const ctx = (workspaceRoot: string) => ({ workspaceRoot, actor: "interactive" as const, autoApprove: false });

describe("AgentLoop", () => {
  it("runs a tool then returns a final answer", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "x.txt"), "hello from disk", "utf8");
    const { bus, agent } = loopWith(['{"tool":"read_file","input":{"path":"x.txt"}}', '{"final":"the file says hello"}'], root);

    const result = await agent.run("what is in x.txt", ctx(root));
    expect(result.toolCalls).toEqual(["read_file"]);
    expect(result.text).toContain("hello");
    expect(bus.replay(undefined).some((event) => event.type === "tool_finished" && event.ok)).toBe(true);
  });

  it("fires the crystallization hook after >= 4 tool calls", async () => {
    const root = await workspace();
    await writeFile(path.join(root, "x.txt"), "data", "utf8");
    const tool = '{"tool":"stat_path","input":{"path":"x.txt"}}';
    const { bus, agent } = loopWith([tool, tool, tool, tool, '{"final":"done"}'], root);

    const result = await agent.run("inspect repeatedly", ctx(root));
    expect(result.toolCalls).toHaveLength(4);
    expect(result.crystallized).toBe(true);
    expect(bus.replay(undefined).some((event) => event.type === "skill_crystallized")).toBe(true);
  });
});
