import { describe, expect, it, vi } from "vitest";
import { classifyCommand } from "../src/server/risk/riskEngine.js";
import { ErrorHub } from "../src/server/errors/errorHub.js";
import { EventBus } from "../src/server/kernel/eventBus.js";
import { athenaError } from "../src/shared/errors.js";
import { compressWindow, summarizeBody } from "../src/server/compression/compressor.js";
import { MemoryStore } from "../src/server/memory/memoryStore.js";
import { InstinctTracker } from "../src/server/memory/instincts.js";
import { ProviderHealth } from "../src/server/providers/providerHealth.js";
import { WatcherEngine } from "../src/server/watchers/watcherEngine.js";

describe("risk engine: unbalanced-quote fail-closed is reachable", () => {
  it("fails closed to Tier 2 on an unterminated quote even for a benign binary", () => {
    expect(classifyCommand("echo 'oops", "posix").tier).toBe(2);
    expect(classifyCommand('type C:\\file" ', "windows").tier).toBe(2);
  });

  it("still classifies balanced quote-obfuscated commands by binary", () => {
    expect(classifyCommand('r"m" -rf /', "posix").tier).toBe(2);
    expect(classifyCommand('echo "all good"', "posix").tier).toBe(1);
  });
});

describe("ErrorHub: sanctioned swallow writes AND emits", () => {
  it("invokes the persistence sink and emits error_detail", () => {
    const bus = new EventBus();
    const sink = vi.fn();
    const hub = new ErrorHub(bus, sink);
    const id = hub.swallow(athenaError("x.y", "test", "error", "boom"));
    expect(sink).toHaveBeenCalledTimes(1);
    expect(sink.mock.calls[0]?.[0]?.id).toBe(id);
    expect(bus.replay(undefined).some((event) => event.type === "error_detail")).toBe(true);
  });
});

describe("compression: summarizes instead of dropping", () => {
  it("keeps signal lines and records elision for long tool output", () => {
    const body = [
      "start of build log",
      ...Array(50).fill("noise noise noise noise noise noise"),
      "ERROR: disk full at /var/log",
      ...Array(50).fill("trailing noise trailing noise"),
      "last line of build log",
    ].join("\n");
    const out = summarizeBody(body, "tool");
    expect(out).toContain("ERROR: disk full at /var/log");
    expect(out).toContain("[summarized");
    expect(out.length).toBeLessThan(body.length);
  });

  it("passes short bodies through untouched", () => {
    expect(compressWindow([{ role: "tool", body: "diagnostic output" }])).toContain("[tool] diagnostic output");
  });
});

describe("memory: hybrid recall (vector first, BM25 fallback)", () => {
  const vocab = ["alpha", "beta", "disk", "network"];
  const embedder = { available: () => true, embed: (text: string) => vocab.map((word) => (text.toLowerCase().includes(word) ? 1 : 0)) };

  it("ranks by vector similarity when embeddings are available", () => {
    const store = new MemoryStore(embedder);
    store.write("alpha covers disk recovery steps");
    store.write("beta covers network latency triage");
    expect(store.recall("alpha disk")[0]?.body).toContain("alpha");
  });

  it("falls back to keyword recall with no embedder", () => {
    const store = new MemoryStore();
    store.write("alpha covers disk recovery steps");
    expect(store.recall("alpha")[0]?.body).toContain("alpha");
  });
});

describe("watchers: only related, active alerts merge", () => {
  it("does not merge unrelated monitors inside the window", () => {
    const watchers = new WatcherEngine();
    const disk = watchers.raise("disk_low", "low", new Date("2026-01-01T00:00:00Z"));
    const login = watchers.raise("login_failures", "high", new Date("2026-01-01T00:01:00Z"));
    expect(login.id).not.toBe(disk.id);
    expect(watchers.alerts()).toHaveLength(2);
  });

  it("merges related monitors inside the window", () => {
    const watchers = new WatcherEngine();
    const cpu = watchers.raise("cpu_spike", "high", new Date("2026-01-01T00:00:00Z"));
    const temp = watchers.raise("temp_high", "critical", new Date("2026-01-01T00:02:00Z"));
    expect(temp.id).toBe(cpu.id);
    expect(temp.severity).toBe("critical");
  });
});

describe("providers: two CONSECUTIVE blocking errors block", () => {
  it("an intervening non-blocking failure resets the streak", () => {
    const health = new ProviderHealth();
    const key = { provider: "openai", model: "gpt" };
    health.recordFailure(key, 429);
    health.recordFailure(key, 500);
    health.recordFailure(key, 429);
    expect(health.isBlocked(key)).toBe(false);
    health.recordFailure(key, 429);
    expect(health.isBlocked(key)).toBe(true);
  });
});

describe("instincts: retire below confidence 40 after repeat sightings", () => {
  it("retires a weak instinct seen in 2+ sessions", () => {
    const tracker = new InstinctTracker();
    expect(tracker.observe("debug", "guess randomly", "s1", 10)).toBeUndefined();
    tracker.observe("debug", "guess randomly", "s2", 5);
    expect(tracker.events().some((event) => event.action === "retired")).toBe(true);
  });
});
