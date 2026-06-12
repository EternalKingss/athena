import type { EventSeq, ServerEvent } from "../../shared/events.js";

export type EventSubscriber = (event: ServerEvent) => void;

const DEFAULT_RING_BYTES = 4 * 1024 * 1024;

export class EventBus {
  #nextSeq: EventSeq = 1;
  #ring: ServerEvent[] = [];
  #ringBytes = 0;
  #subscribers = new Set<EventSubscriber>();

  constructor(private readonly maxRingBytes = DEFAULT_RING_BYTES) {}

  emit<T extends Omit<ServerEvent, "seq" | "ts">>(event: T): ServerEvent {
    const sequenced = {
      ...event,
      seq: this.#nextSeq++,
      ts: new Date().toISOString(),
    } as ServerEvent;

    this.#append(sequenced);
    for (const subscriber of this.#subscribers) {
      subscriber(sequenced);
    }
    return sequenced;
  }

  replay(since: EventSeq | undefined): ServerEvent[] {
    if (since === undefined) return [...this.#ring];
    return this.#ring.filter((event) => event.seq > since);
  }

  get replayBytes(): number {
    return this.#ringBytes;
  }

  subscribe(subscriber: EventSubscriber): () => void {
    this.#subscribers.add(subscriber);
    return () => this.#subscribers.delete(subscriber);
  }

  #append(event: ServerEvent): void {
    const size = Buffer.byteLength(JSON.stringify(event), "utf8");
    this.#ring.push(event);
    this.#ringBytes += size;

    while (this.#ringBytes > this.maxRingBytes && this.#ring.length > 0) {
      const removed = this.#ring.shift();
      if (!removed) return;
      this.#ringBytes -= Buffer.byteLength(JSON.stringify(removed), "utf8");
    }
  }
}
