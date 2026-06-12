import { describe, expect, it } from "vitest";
import { EventBus } from "../src/server/kernel/eventBus.js";
import { createMockProvider, StreamingRouter } from "../src/server/providers/router.js";
import { TurnEngine } from "../src/server/turns/turnEngine.js";

describe("providers and turns", () => {
  it("emits visible failover and preserves output", async () => {
    const bus = new EventBus();
    const router = new StreamingRouter([
      createMockProvider("openai", "gpt-test", [], 429),
      createMockProvider("local", "qwen-test", ["ok"]),
    ]);
    const chunks = [];
    for await (const chunk of router.stream("debug", bus)) chunks.push(chunk.text);
    expect(chunks.join("")).toBe("ok");
    expect(bus.replay(undefined).some((event) => event.type === "failover")).toBe(true);
  });

  it("answers L2 turns without a provider", async () => {
    const bus = new EventBus();
    const engine = new TurnEngine(bus);
    const answer = await engine.run("status", "cli");
    expect(answer).toContain("kernel");
    expect(bus.replay(undefined).some((event) => event.type === "turn_finished" && event.ok)).toBe(true);
  });
});
