import { createHash } from "node:crypto";

export type VendorArtifact = {
  name: string;
  platform: "win-x64" | "mac-arm64" | "linux-x64" | "all";
  path: string;
  sha256: string;
  required: boolean;
};

export type VendorManifest = {
  node: { version: string; moduleVersion: number };
  artifacts: VendorArtifact[];
};

export function verifySha256(bytes: Uint8Array, expected: string): boolean {
  return createHash("sha256").update(bytes).digest("hex") === expected;
}

export function missingRequiredArtifacts(manifest: VendorManifest, availablePaths: Set<string>): VendorArtifact[] {
  return manifest.artifacts.filter((artifact) => artifact.required && !availablePaths.has(artifact.path));
}
