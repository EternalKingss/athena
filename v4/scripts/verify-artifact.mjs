import { execFile } from "node:child_process";
import { mkdtemp, cp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const dist = path.join(root, "dist");
const sandbox = await mkdtemp(path.join(tmpdir(), "athena-v4-artifact-"));

try {
  await assertExists(path.join(dist, "server.js"));
  await assertExists(path.join(dist, "cli.js"));
  await cp(dist, path.join(sandbox, "dist"), { recursive: true });

  const doctor = await execFileAsync(process.execPath, [path.join(sandbox, "dist", "cli.js"), "doctor"], {
    cwd: sandbox,
    env: { ...process.env, NODE_PATH: "" },
  });
  const selfCheck = JSON.parse(doctor.stdout);
  if (selfCheck.sqliteAvailable !== true || selfCheck.fts5Available !== true) {
    throw new Error(`Artifact sqlite/FTS5 self-check failed: ${doctor.stdout}`);
  }

  const serverModule = await import(pathToFileURL(path.join(sandbox, "dist", "server.js")).href);
  const started = await serverModule.startServer({
    port: 0,
    token: "a".repeat(64),
    dbPath: ":memory:",
  });
  await started.close();
} finally {
  await rm(sandbox, { recursive: true, force: true });
}

async function assertExists(file) {
  try {
    await access(file);
  } catch {
    throw new Error(`Missing built artifact: ${file}`);
  }
}
