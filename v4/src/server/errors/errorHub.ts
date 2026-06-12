import { randomUUID } from "node:crypto";
import type { AthenaError } from "../../shared/events.js";
import type { EventBus } from "../kernel/eventBus.js";

export type ErrorRecord = {
  id: string;
  error: AthenaError;
  createdAt: string;
};

export type ErrorSink = (record: ErrorRecord) => void;

/**
 * The sanctioned swallow path (SEMANTICS: "writes `errors` and emits `error_detail`").
 * The sink is the persistence side-effect; the bus emit is the live signal. A missing
 * sink degrades to emit-only (used in unit contexts), never to a silent drop.
 */
export class ErrorHub {
  constructor(
    private readonly bus: EventBus,
    private readonly sink?: ErrorSink,
  ) {}

  swallow(error: AthenaError): string {
    const record: ErrorRecord = { id: randomUUID(), error, createdAt: new Date().toISOString() };
    this.sink?.(record);
    this.bus.emit({ type: "error_detail", error });
    return record.id;
  }
}
