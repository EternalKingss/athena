import { randomUUID } from "node:crypto";
import { answerWithL2 } from "../brain/l2Engine.js";
import type { EventBus } from "../kernel/eventBus.js";
import type { StreamingRouter } from "../providers/router.js";
import { classifyCommand } from "../risk/riskEngine.js";
import type { ExecutionContext, ToolExecutor, ToolInput } from "../tools/executor.js";

export type TurnSource = "cli" | "ui" | "background";

export type TurnEngineOptions = {
  router?: StreamingRouter;
  executor?: ToolExecutor;
  getExecutionContext?: (source: TurnSource) => ExecutionContext;
};

/**
 * Resolves a turn. A leading slash command is a deterministic, offline control
 * surface routed through the tool executor (so the security model still applies):
 *   /tool <name> <json>   run a tool
 *   /risk <command>       show the risk verdict for a command
 *   /recall <query>       recall memory
 * Otherwise it falls back to deterministic L2 answers, then the provider router.
 */
export class TurnEngine {
  constructor(
    private readonly bus: EventBus,
    private readonly options: TurnEngineOptions = {},
  ) {}

  async run(text: string, source: TurnSource = "cli"): Promise<string> {
    const id = randomUUID();
    this.bus.emit({ type: "turn_started", id, source });
    this.bus.emit({ type: "chat_received", id, text });

    const trimmed = text.trim();
    if (trimmed.startsWith("/") && this.options.executor) {
      const handled = await this.#handleCommand(id, trimmed, source);
      if (handled !== undefined) {
        this.bus.emit({ type: "turn_finished", id, ok: handled.ok });
        return handled.output;
      }
    }

    const l2 = answerWithL2(text);
    if (l2.matched) {
      this.bus.emit({ type: "text_delta", id, text: l2.text });
      this.bus.emit({ type: "turn_finished", id, ok: true });
      return l2.text;
    }

    let output = "";
    if (this.options.router) {
      for await (const chunk of this.options.router.stream(text, this.bus)) {
        output += chunk.text;
        this.bus.emit({ type: "text_delta", id, text: chunk.text });
      }
    }

    this.bus.emit({ type: "turn_finished", id, ok: output.length > 0 });
    return output;
  }

  #context(source: TurnSource): ExecutionContext {
    return (
      this.options.getExecutionContext?.(source) ?? {
        workspaceRoot: process.cwd(),
        actor: source === "background" ? "background" : "interactive",
        autoApprove: false,
      }
    );
  }

  async #handleCommand(id: string, text: string, source: TurnSource): Promise<{ ok: boolean; output: string } | undefined> {
    const body = text.slice(1);
    const split = body.indexOf(" ");
    const command = (split === -1 ? body : body.slice(0, split)).toLowerCase();
    const arg = split === -1 ? "" : body.slice(split + 1).trim();
    const ctx = this.#context(source);

    if (command === "risk") {
      const output = JSON.stringify(classifyCommand(arg));
      this.bus.emit({ type: "text_delta", id, text: output });
      return { ok: true, output };
    }

    if (command === "recall") {
      const outcome = await this.options.executor!.execute("memory_recall", { query: arg }, ctx);
      this.bus.emit({ type: "text_delta", id, text: outcome.output });
      return { ok: outcome.ok, output: outcome.output };
    }

    if (command === "tool") {
      const argSplit = arg.indexOf(" ");
      const name = argSplit === -1 ? arg : arg.slice(0, argSplit);
      const jsonText = argSplit === -1 ? "" : arg.slice(argSplit + 1).trim();
      const input = parseJsonInput(jsonText);
      if (input === undefined) {
        const output = `invalid tool input json`;
        this.bus.emit({ type: "error_detail", error: { code: "turn.bad_tool_json", source: "turns", severity: "warning", message: output } });
        this.bus.emit({ type: "text_delta", id, text: output });
        return { ok: false, output };
      }
      const outcome = await this.options.executor!.execute(name, input, ctx);
      this.bus.emit({ type: "text_delta", id, text: outcome.output });
      return { ok: outcome.ok, output: outcome.output };
    }

    return undefined;
  }
}

function parseJsonInput(text: string): ToolInput | undefined {
  if (text.length === 0) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as ToolInput) : undefined;
  } catch {
    return undefined;
  }
}
