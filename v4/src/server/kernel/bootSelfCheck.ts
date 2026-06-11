export type BootSelfCheckResult = {
  nodeVersion: string;
  sqliteAvailable: boolean;
  fts5Available: boolean;
};

export async function runBootSelfCheck(): Promise<BootSelfCheckResult> {
  const result: BootSelfCheckResult = {
    nodeVersion: process.versions.node,
    sqliteAvailable: false,
    fts5Available: false,
  };

  try {
    const sqlite = await import("node:sqlite");
    result.sqliteAvailable = true;

    const db = new sqlite.DatabaseSync(":memory:");
    try {
      const row = db.prepare("SELECT fts5(?1) AS ok").get("athena") as { ok?: unknown } | undefined;
      result.fts5Available = row?.ok !== undefined;
    } finally {
      db.close();
    }
  } catch {
    result.sqliteAvailable = false;
    result.fts5Available = false;
  }

  return result;
}
