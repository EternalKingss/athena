import { describe, expect, it } from "vitest";
import { ApprovalManager } from "../src/server/approvals/sessionLeases.js";
import { BYPASS_CORPUS, classifyCommand, V3_RATCHET_CASES } from "../src/server/risk/riskEngine.js";
import { ToolRegistry, TOOL_MANIFESTS } from "../src/server/tools/registry.js";

describe("risk engine and approvals", () => {
  it("dominates the v3 ratchet and bypass corpus", () => {
    for (const item of [...V3_RATCHET_CASES, ...BYPASS_CORPUS]) {
      expect(classifyCommand(item.command, item.platform).tier).toBeGreaterThanOrEqual(item.tier);
    }
  });

  it("fails closed on parse failures and blocks background Tier 2", () => {
    expect(classifyCommand("rm 'unterminated", "posix").tier).toBe(2);
    const approvals = new ApprovalManager();
    const decision = approvals.decide("rm -rf ~", 2, { actor: "background", autoApprove: true });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("background_tier2_denied");
  });

  it("session leases hash scope and cap tool output", () => {
    const approvals = new ApprovalManager();
    const lease = approvals.grant("rm -rf ./tmp", new Date("2026-01-01T00:00:00Z"));
    expect(approvals.decide("RM -RF ./tmp", 2, { actor: "interactive", autoApprove: false, now: new Date("2026-01-01T00:01:00Z") }).lease?.scopeHash).toBe(lease.scopeHash);

    const registry = new ToolRegistry();
    expect(TOOL_MANIFESTS.length).toBeGreaterThanOrEqual(20);
    expect(registry.capOutput("log_tail", "x".repeat(300_000)).capped).toBe(true);
  });
});
