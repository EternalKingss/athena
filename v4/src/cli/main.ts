import { createCompositionRoot } from "../server/kernel/compositionRoot.js";
import { startServer } from "../server/main.js";
import { buildCloudProviders } from "../server/providers/cloudProviders.js";

export async function runCli(argv: string[]): Promise<string | undefined> {
  const command = argv[2] ?? "serve";

  if (command === "serve") {
    const started = await startServer();
    return `Athena v4 server listening at ${started.url}`;
  }

  if (command === "doctor") {
    const { runBootSelfCheck } = await import("../server/kernel/bootSelfCheck.js");
    const result = await runBootSelfCheck();
    return JSON.stringify(result, null, 2);
  }

  if (command === "ask") {
    const llamaBaseUrl = process.env.ATHENA_LLAMA_URL;
    const workspaceRoot = process.env.ATHENA_WORKSPACE;
    const root = createCompositionRoot({
      providers: buildCloudProviders(),
      ...(llamaBaseUrl === undefined ? {} : { llamaBaseUrl }),
      ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
    });
    await root.init();
    try {
      return await root.turnEngine.run(argv.slice(3).join(" ") || "status", "cli");
    } finally {
      await root.close();
    }
  }

  throw new Error(`Unknown command: ${command}`);
}

if (process.argv[1]?.endsWith("cli.js")) {
  try {
    const output = await runCli(process.argv);
    if (output !== undefined) console.log(output);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
