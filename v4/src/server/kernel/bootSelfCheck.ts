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
      db.exec("CREATE VIRTUAL TABLE athena_fts_probe USING fts5(body)");
      db.prepare("INSERT INTO athena_fts_probe (body) VALUES (?)").run("athena");
      const row = db.prepare("SELECT rowid FROM athena_fts_probe WHERE athena_fts_probe MATCH ?").get("athena");
      result.fts5Available = row !== undefined;
    } finally {
      db.close();
    }
  } catch {
    if (result.sqliteAvailable) {
      result.fts5Available = false;
      return result;
    }
    result.sqliteAvailable = false;
    result.fts5Available = false;
    return result;
  }

  return result;
}
