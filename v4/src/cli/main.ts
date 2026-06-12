import { startServer } from "../server/main.js";

const command = process.argv[2] ?? "serve";

if (command === "serve") {
  const started = await startServer();
  console.log(`Athena v4 server listening at ${started.url}`);
} else if (command === "doctor") {
  const { runBootSelfCheck } = await import("../server/kernel/bootSelfCheck.js");
  const result = await runBootSelfCheck();
  console.log(JSON.stringify(result, null, 2));
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
