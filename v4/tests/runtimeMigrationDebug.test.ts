import { describe, expect, it } from "vitest";
import { compressWindow } from "../src/server/compression/compressor.js";
import { mergeLogLines, parseStacktrace, summarizeNetDebug } from "../src/server/debug/debugTools.js";
import { planV3Migration, diffMigration } from "../src/server/migration/migrateV3.js";
import { offlineMode, selectLocalModel } from "../src/server/offline/localModel.js";
import { missingRequiredArtifacts, verifySha256, type VendorManifest } from "../src/server/runtime/manifest.js";

describe("runtime, migration, debug, and offline brain", () => {
  it("selects local models and offline mode", () => {
    expect(selectLocalModel(8).id).toBe("qwen2.5-coder-1.5b");
    expect(selectLocalModel(16).id).toBe("qwen2.5-coder-3b");
    expect(selectLocalModel(32).id).toBe("qwen2.5-coder-7b");
    expect(offlineMode(false, false)).toBe("offline");
  });

  it("plans migration idempotently and diffs parity", () => {
    const files = [
      { path: "athena.md", content: "memory" },
      { path: "skills/fix/SKILL.md", content: "skill" },
      { path: "prohibited_patterns.md", content: "secret" },
    ];
    const report = planV3Migration(files);
    expect(diffMigration(report, planV3Migration(files))).toEqual([]);
    expect(report.skills).toBe(1);
  });

  it("verifies runtime artifacts and debug helpers", () => {
    expect(verifySha256(Buffer.from("athena"), "084328c53a9de563b83b23b6f500521ff442af7cfe60f104574c2c8cce22cf2a")).toBe(true);
    const manifest: VendorManifest = { node: { version: "22.13.0", moduleVersion: 127 }, artifacts: [{ name: "node", platform: "linux-x64", path: "runtime/linux-x64/node/bin/node", sha256: "x", required: true }] };
    expect(missingRequiredArtifacts(manifest, new Set())).toHaveLength(1);
    expect(parseStacktrace("Error\n    at main (file.js:1:1)").language).toBe("node");
    expect(mergeLogLines([{ source: "b", ts: "2026-01-01T00:00:02Z", line: "2" }, { source: "a", ts: "2026-01-01T00:00:01Z", line: "1" }])[0]?.line).toBe("1");
    expect(summarizeNetDebug("example.test", { dnsMs: 1 }).tcpMs).toBe(0);
  });

  it("compresses tool output into context", () => {
    expect(compressWindow([{ role: "tool", body: "diagnostic output" }])).toContain("[tool] diagnostic output");
  });
});
