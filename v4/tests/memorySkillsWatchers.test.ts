import { describe, expect, it } from "vitest";
import { CoralLog } from "../src/server/coral/coralLog.js";
import { fingerprintHost } from "../src/server/machines/fingerprint.js";
import { bm25Fallback, recallCascade } from "../src/server/memory/embeddings.js";
import { InstinctTracker } from "../src/server/memory/instincts.js";
import { MemoryStore } from "../src/server/memory/memoryStore.js";
import { shouldCrystallize, SkillRegistry } from "../src/server/skills/skillTrust.js";
import { WatcherEngine } from "../src/server/watchers/watcherEngine.js";

describe("memory, skills, coral, and watchers", () => {
  it("merges near duplicates, flags contradictions, and recalls offline", () => {
    const memory = new MemoryStore();
    memory.write("Athena should always use offline recall for no-key mode");
    expect(memory.write("Athena should always use offline recall when no keys are set").action).toBe("merged");
    expect(memory.write("Athena should never use offline recall for no-key mode").action).toBe("flagged");
    expect(memory.recall("offline recall").length).toBeGreaterThan(0);
    expect(bm25Fallback("offline", ["cloud only", "offline recall works"])).toEqual(["offline recall works"]);
    expect(recallCascade("offline", ["offline recall works"], [{ name: "cloud", available: () => false, recall: () => ["no"] }]).provider).toBe("bm25");
  });

  it("promotes instincts only with confidence and session spread", () => {
    const tracker = new InstinctTracker();
    expect(tracker.observe("debug", "check logs first", "s1", 40)).toBeUndefined();
    expect(tracker.observe("debug", "check logs first", "s2", 30)).toBeUndefined();
    const promoted = tracker.observe("debug", "check logs first", "s3", 20);
    expect(promoted?.confidence).toBeGreaterThanOrEqual(85);
    expect(tracker.events().some((event) => event.action === "promoted")).toBe(true);
  });

  it("enforces skill trust and turn-boundary CORAL", () => {
    const skills = new SkillRegistry();
    skills.saveUnverified("repair-node", "steps");
    expect(skills.load("repair-node", "background").allowed).toBe(false);
    expect(skills.load("repair-node", "interactive").reason).toBe("tier2_unverified_skill_gate");
    skills.promote("repair-node");
    expect(skills.load("repair-node", "background").allowed).toBe(true);
    expect(shouldCrystallize(["read_file", "search_text", "patch_file", "test", "load_skill"])).toBe(true);

    const coral = new CoralLog();
    coral.append("win32", "path rule");
    expect(coral.persisted()).toHaveLength(0);
    expect(coral.pullAtTurnBoundary("win32")).toHaveLength(1);
  });

  it("correlates watcher alerts and keeps fingerprints hashed", () => {
    const watchers = new WatcherEngine();
    const first = watchers.raise("cpu_spike", "high", new Date("2026-01-01T00:00:00Z"));
    const merged = watchers.raise("ram_pressure", "high", new Date("2026-01-01T00:04:00Z"));
    expect(merged.id).toBe(first.id);
    watchers.beginTurn();
    const critical = watchers.raise("temp_high", "critical", new Date("2026-01-01T00:10:00Z"));
    expect(watchers.checkpointRequired(critical)).toBe(true);
    expect(watchers.endTurn()).toHaveLength(1);

    const fingerprint = fingerprintHost({ username: "force", macs: ["aa:bb"], hostname: "host" });
    expect(fingerprint).not.toContain("force");
    expect(fingerprint).toHaveLength(64);
  });
});
