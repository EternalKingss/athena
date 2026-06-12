export type ApprovalResponse = { approved: boolean; forSession: boolean };

const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * Bridges an async Tier 2 approval: the executor emits `approval_required` and
 * awaits request(id); the transport resolves it when the UI sends an
 * `approval_response`. Unanswered requests fail closed (denied) after a timeout.
 */
export class ApprovalBroker {
  #pending = new Map<string, (response: ApprovalResponse) => void>();

  request(id: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<ApprovalResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        resolve({ approved: false, forSession: false });
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#pending.set(id, (response) => {
        clearTimeout(timer);
        this.#pending.delete(id);
        resolve(response);
      });
    });
  }

  resolve(id: string, approved: boolean, forSession = false): boolean {
    const settle = this.#pending.get(id);
    if (!settle) return false;
    settle({ approved, forSession });
    return true;
  }

  pendingCount(): number {
    return this.#pending.size;
  }
}
