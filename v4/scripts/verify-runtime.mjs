// Drive-side boot gate: verify vendored artifacts against vendor/manifest.json
// before launching. Required artifacts must be present, pinned, and match.
// Optional artifacts (model, llama-server) are integrity-checked only when
// present and pinned; an absent optional artifact is fine (offline L2 fallback).
//
// Hashing streams the file so multi-GB models (larger than fs.readFile's ~2GB
// Buffer limit) verify correctly.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import { readFile } from "node:fs/promises";

const root = process.argv[2] ?? process.cwd();
const platformKey = process.platform === "win32" ? "win-x64" : process.platform === "darwin" ? "mac-arm64" : "linux-x64";

const manifest = JSON.parse(await readFile(path.join(root, "vendor", "manifest.json"), "utf8"));
let failed = false;

for (const artifact of manifest.artifacts) {
  if (artifact.platform !== platformKey && artifact.platform !== "all") continue;

  const file = path.join(root, artifact.path);
  let present = true;
  try {
    await stat(file);
  } catch {
    present = false;
  }

  if (!present) {
    if (artifact.required) {
      console.error(`MISSING   ${artifact.path}`);
      failed = true;
    } else {
      console.log(`skip      ${artifact.path} (optional, absent)`);
    }
    continue;
  }

  if (artifact.sha256 === "TO_BE_PINNED_BY_SETUP") {
    if (artifact.required) {
      console.error(`UNPINNED  ${artifact.path}`);
      failed = true;
    } else {
      console.log(`skip      ${artifact.path} (optional, unpinned)`);
    }
    continue;
  }

  const digest = await hashFile(file);
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

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}
