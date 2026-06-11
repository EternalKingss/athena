import { describe, expect, it } from "vitest";
import { EventBus } from "../src/server/kernel/eventBus.js";

describe("EventBus", () => {
  it("assigns monotonically increasing sequence numbers", () => {
    const bus = new EventBus();
    const first = bus.emit({ type: "boot_started", version: "test" });
    const second = bus.emit({ type: "boot_ready" });

    expect(first.seq).toBe(1);
    expect(second.seq).toBe(2);
    expect(bus.replay(1).map((event) => event.seq)).toEqual([2]);
  });

  it("keeps replay storage byte bounded", () => {
    const bus = new EventBus(260);
    for (let i = 0; i < 10; i += 1) {
      bus.emit({ type: "text_delta", id: String(i), text: "x".repeat(80) });
    }

    const replayed = bus.replay(undefined);
    expect(replayed.length).toBeGreaterThan(0);
    expect(replayed.length).toBeLessThan(10);
    expect(replayed.at(-1)?.seq).toBe(10);
  });
});
