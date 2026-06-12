import { randomUUID } from "node:crypto";
import { answerWithL2 } from "../brain/l2Engine.js";
import type { EventBus } from "../kernel/eventBus.js";
import type { StreamingRouter } from "../providers/router.js";

export type TurnEngineOptions = {
  router?: StreamingRouter;
};

export class TurnEngine {
  constructor(
    private readonly bus: EventBus,
    private readonly options: TurnEngineOptions = {},
  ) {}

  async run(text: string, source: "cli" | "ui" | "background" = "cli"): Promise<string> {
    const id = randomUUID();
    let output = "";
    this.bus.emit({ type: "turn_started", id, source });
    this.bus.emit({ type: "chat_received", id, text });

    const l2 = answerWithL2(text);
    if (l2.matched) {
      output = l2.text;
      this.bus.emit({ type: "text_delta", id, text: output });
      this.bus.emit({ type: "turn_finished", id, ok: true });
      return output;
    }

    if (this.options.router) {
      for await (const chunk of this.options.router.stream(text, this.bus)) {
        output += chunk.text;
        this.bus.emit({ type: "text_delta", id, text: chunk.text });
      }
    }

    this.bus.emit({ type: "turn_finished", id, ok: output.length > 0 });
    return output;
  }
}
