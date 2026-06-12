import { randomUUID } from "node:crypto";
import type { AthenaError } from "../../shared/events.js";
import type { EventBus } from "../kernel/eventBus.js";

export class ErrorHub {
  constructor(private readonly bus: EventBus) {}

  swallow(error: AthenaError): string {
    const id = randomUUID();
    this.bus.emit({ type: "error_detail", error });
    return id;
  }
}
