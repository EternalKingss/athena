import { randomBytes } from "node:crypto";
import { EventBus } from "./eventBus.js";
import { DbWorker } from "./dbWorker.js";

export type CompositionRootOptions = {
  token?: string;
  maxReplayBytes?: number;
  dbPath?: string;
};

export type CompositionRoot = {
  bus: EventBus;
  db: DbWorker;
  token: string;
  close: () => Promise<void>;
};

export function createCompositionRoot(options: CompositionRootOptions = {}): CompositionRoot {
  const bus = new EventBus(options.maxReplayBytes);
  const db = new DbWorker(options.dbPath === undefined ? {} : { dbPath: options.dbPath });
  const token = options.token ?? randomBytes(32).toString("hex");

  return {
    bus,
    db,
    token,
    close: async () => {
      await db.close();
    },
  };
}
