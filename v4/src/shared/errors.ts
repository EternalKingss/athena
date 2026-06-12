import type { AthenaError, Severity } from "./events.js";

export class AthenaRuntimeError extends Error {
  readonly detail: AthenaError;

  constructor(detail: AthenaError) {
    super(detail.message);
    this.name = "AthenaRuntimeError";
    this.detail = detail;
  }
}

export function athenaError(code: string, source: string, severity: Severity, message: string, hint?: string): AthenaError {
  return {
    code,
    source,
    severity,
    message,
    ...(hint === undefined ? {} : { hint }),
  };
}
