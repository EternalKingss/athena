import type { EventBus } from "../kernel/eventBus.js";
import type { StreamingRouter } from "../providers/router.js";
import { shouldCrystallize } from "../skills/skillTrust.js";
import type { ExecutionContext, ToolExecutor, ToolInput } from "../tools/executor.js";

export type AgentLoopDeps = {
  bus: EventBus;
  router: StreamingRouter;
  executor: ToolExecutor;
};

export type AgentLoopResult = {
  text: string;
  toolCalls: string[];
  iterations: number;
  crystallized: boolean;
};

type Directive = { tool?: string; input?: ToolInput; final?: string };

const DEFAULT_MAX_ITERATIONS = 6;
const TOOL_RESULT_CLIP = 2_000;

/**
 * Agentic tool-calling loop. The model is told the tool catalog and replies with
 * a single JSON directive per step: {"tool","input"} to act, {"final"} to answer.
 * Each tool runs through the executor (so the risk/approval/cap/audit pipeline
 * still applies), the result is fed back, and the loop continues until a final
 * answer or the iteration cap. A task with >= 4 non-skill tool calls fires the
 * crystallization hook (SEMANTICS).
 */
export class AgentLoop {
  constructor(private readonly deps: AgentLoopDeps) {}

  async run(userPrompt: string, ctx: ExecutionContext, maxIterations = DEFAULT_MAX_ITERATIONS): Promise<AgentLoopResult> {
    const toolCalls: string[] = [];
    const transcript: string[] = [systemPrompt(this.deps.executor.implemented()), `User: ${userPrompt}`];
    let finalText = "";
    let iterations = 0;

    for (; iterations < maxIterations; iterations += 1) {
      const modelText = await this.#complete(`${transcript.join("\n")}\nAssistant:`);
      const directive = parseDirective(modelText);

      if (directive?.final !== undefined) {
        finalText = directive.final;
        break;
      }
      if (directive?.tool === undefined) {
        finalText = modelText.trim();
        break;
      }

      const input = directive.input && typeof directive.input === "object" ? directive.input : {};
      const outcome = await this.deps.executor.execute(directive.tool, input, ctx);
      toolCalls.push(directive.tool);
      transcript.push(`Assistant: ${modelText.trim()}`);
      transcript.push(`Tool(${directive.tool}) -> ${outcome.output.slice(0, TOOL_RESULT_CLIP)}`);
    }

    const crystallized = shouldCrystallize(toolCalls);
    if (crystallized) {
      this.deps.bus.emit({ type: "skill_crystallized", skill: `task-${userPrompt.slice(0, 24)}`, version: 1, verified: false });
    }
    return { text: finalText, toolCalls, iterations, crystallized };
  }

  async #complete(prompt: string): Promise<string> {
    let text = "";
    for await (const chunk of this.deps.router.stream(prompt, this.deps.bus)) text += chunk.text;
    return text;
  }
}

function systemPrompt(tools: string[]): string {
  return [
    "You are Athena, a portable debugging companion.",
    'To use a tool, reply with ONLY a JSON object: {"tool":"<name>","input":{...}}.',
    'When finished, reply with ONLY: {"final":"<answer>"}.',
    `Available tools: ${tools.join(", ")}.`,
  ].join("\n");
}

function parseDirective(text: string): Directive | undefined {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence?.[1] ?? sliceFirstObject(text);
  if (candidate === undefined) return undefined;
  try {
    const parsed = JSON.parse(candidate.trim()) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Directive) : undefined;
  } catch {
    return undefined;
  }
}

function sliceFirstObject(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return undefined;
}
