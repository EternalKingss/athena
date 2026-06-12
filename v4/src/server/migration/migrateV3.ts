import { createHash } from "node:crypto";

export type LegacyFile = {
  path: string;
  content: string;
};

export type MigrationReport = {
  legacySnapshotCount: number;
  memoryEntries: number;
  prohibitedPatterns: number;
  skills: number;
  contentHashes: string[];
};

export function planV3Migration(files: LegacyFile[]): MigrationReport {
  const contentHashes = files.map((file) => hash(file.content));
  return {
    legacySnapshotCount: files.length,
    memoryEntries: files.filter((file) => /(^|[\\/])(athena|user|summary)\.md$/i.test(file.path)).length,
    prohibitedPatterns: files.filter((file) => /prohibited_patterns\.md$/i.test(file.path)).length,
    skills: files.filter((file) => /skills[\\/][^\\/]+[\\/]SKILL\.md$/i.test(file.path)).length,
    contentHashes,
  };
}

export function diffMigration(expected: MigrationReport, actual: MigrationReport): string[] {
  const mismatches: string[] = [];
  for (const key of ["legacySnapshotCount", "memoryEntries", "prohibitedPatterns", "skills"] as const) {
    if (expected[key] !== actual[key]) mismatches.push(`${key}: expected ${expected[key]}, got ${actual[key]}`);
  }
  for (const hashValue of expected.contentHashes) {
    if (!actual.contentHashes.includes(hashValue)) mismatches.push(`missing hash ${hashValue}`);
  }
  return mismatches;
}

function hash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}
