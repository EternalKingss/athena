// Drive-side boot gate: verify vendored artifacts against vendor/manifest.json
// before launching. Fails closed (non-zero exit) on any missing, unpinned, or
// mismatched required artifact for the current platform.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const root = process.argv[2] ?? process.cwd();
const platformKey = process.platform === "win32" ? "win-x64" : process.platform === "darwin" ? "mac-arm64" : "linux-x64";

const manifest = JSON.parse(await readFile(path.join(root, "vendor", "manifest.json"), "utf8"));
let failed = false;

for (const artifact of manifest.artifacts) {
  if (!artifact.required) continue;
  if (artifact.platform !== platformKey && artifact.platform !== "all") continue;

  const file = path.join(root, artifact.path);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    console.error(`MISSING   ${artifact.path}`);
    failed = true;
    continue;
  }
  if (artifact.sha256 === "TO_BE_PINNED_BY_SETUP") {
    console.error(`UNPINNED  ${artifact.path}`);
    failed = true;
    continue;
  }
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (digest === artifact.sha256) {
    console.log(`OK        ${artifact.path}`);
  } else {
    console.error(`MISMATCH  ${artifact.path}`);
    failed = true;
  }
}

if (failed) {
  console.error(`Runtime verification FAILED for ${platformKey}.`);
  process.exit(1);
}
console.log(`Runtime verified for ${platformKey} (Node ${manifest.node.version}).`);
