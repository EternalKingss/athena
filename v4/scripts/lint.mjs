import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("..", import.meta.url);
const checkedExtensions = new Set([".ts", ".svelte", ".mjs"]);
const banned = [
  { pattern: /\.catch\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/g, message: "bare empty catch is banned" },
];

let failed = false;

for await (const file of walk(new URL("src/", root))) {
  if (!checkedExtensions.has(path.extname(file.pathname))) continue;
  const text = await readFile(file, "utf8");
  for (const rule of banned) {
    if (rule.pattern.test(text)) {
      console.error(`${file.pathname}: ${rule.message}`);
      failed = true;
    }
  }
}

if (failed) process.exitCode = 1;

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name, dir);
    if (entry.isDirectory()) {
      yield* walk(new URL(`${entry.name}/`, dir));
    } else if (entry.isFile()) {
      yield child;
    }
  }
}
