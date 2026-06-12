import { createHash, randomUUID } from "node:crypto";
import type { RiskTier } from "../../shared/events.js";

export type ApprovalLease = {
  id: string;
  scopeHash: string;
  grantedAt: string;
  expiresAt: string;
  autoApproved: boolean;
};

export type ApprovalContext = {
  actor: "interactive" | "background";
  autoApprove: boolean;
  now?: Date;
};

const MAX_TTL_MS = 4 * 60 * 60 * 1000;

export class ApprovalManager {
  #leases = new Map<string, ApprovalLease>();

  decide(command: string, tier: RiskTier, context: ApprovalContext): { allowed: boolean; lease?: ApprovalLease; reason: string } {
    if (tier < 2) return { allowed: true, reason: "tier_below_blocking" };
    if (context.actor === "background") return { allowed: false, reason: "background_tier2_denied" };
    const existing = this.#leases.get(hashScope(command));
    const now = context.now ?? new Date();
    if (existing && Date.parse(existing.expiresAt) > now.getTime()) {
      return { allowed: true, lease: existing, reason: "session_lease" };
    }
    if (context.autoApprove) {
      const lease = this.grant(command, now, true);
      return { allowed: true, lease, reason: "interactive_auto_approved" };
    }
    return { allowed: false, reason: "explicit_approval_required" };
  }

  grant(command: string, now = new Date(), autoApproved = false, ttlMs = MAX_TTL_MS): ApprovalLease {
    const boundedTtl = Math.min(ttlMs, MAX_TTL_MS);
    const lease: ApprovalLease = {
      id: randomUUID(),
      scopeHash: hashScope(command),
      grantedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + boundedTtl).toISOString(),
      autoApproved,
    };
    this.#leases.set(lease.scopeHash, lease);
    return lease;
  }
}

export function hashScope(command: string): string {
  return createHash("sha256").update(command.trim().toLowerCase()).digest("hex");
}
