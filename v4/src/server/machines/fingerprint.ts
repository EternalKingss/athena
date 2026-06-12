import { createHash } from "node:crypto";

export type HostIdentifiers = {
  machineGuid?: string;
  hostname?: string;
  platform?: string;
  arch?: string;
  macs?: string[];
  username?: string;
};

export function fingerprintHost(identifiers: HostIdentifiers): string {
  const stable = {
    machineGuid: identifiers.machineGuid ?? "",
    hostname: identifiers.hostname ?? "",
    platform: identifiers.platform ?? "",
    arch: identifiers.arch ?? "",
    macs: [...(identifiers.macs ?? [])].sort(),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

export function snapshotDiff(previous: Record<string, unknown>, next: Record<string, unknown>): Record<string, { before: unknown; after: unknown }> {
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const diff: Record<string, { before: unknown; after: unknown }> = {};
  for (const key of keys) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(next[key])) {
      diff[key] = { before: previous[key], after: next[key] };
    }
  }
  return diff;
}
