import { startServer } from "../server/main.js";
import { EventBus } from "../server/kernel/eventBus.js";
import { TurnEngine } from "../server/turns/turnEngine.js";

const command = process.argv[2] ?? "serve";

if (command === "serve") {
  const started = await startServer();
  console.log(`Athena v4 server listening at ${started.url}`);
} else if (command === "doctor") {
  const { runBootSelfCheck } = await import("../server/kernel/bootSelfCheck.js");
  const result = await runBootSelfCheck();
  console.log(JSON.stringify(result, null, 2));
} else if (command === "ask") {
  const bus = new EventBus();
  const engine = new TurnEngine(bus);
  const answer = await engine.run(process.argv.slice(3).join(" ") || "status", "cli");
  console.log(answer);
} else {
  console.error(`Unknown command: ${command}`);
  process.exitCode = 1;
}
