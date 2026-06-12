export const ATHENA_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS machines (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS machine_snapshots (
  id TEXT PRIMARY KEY,
  machine_id TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  snapshot_json TEXT NOT NULL,
  FOREIGN KEY (machine_id) REFERENCES machines(id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  started_at TEXT NOT NULL,
  compressed_context TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id)
);

CREATE TABLE IF NOT EXISTS memory_entries (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  validated INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS instincts (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL,
  body TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  seen_sessions INTEGER NOT NULL,
  machine_id TEXT
);

CREATE TABLE IF NOT EXISTS instinct_events (
  id TEXT PRIMARY KEY,
  instinct_id TEXT NOT NULL,
  action TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prohibited_patterns (
  id TEXT PRIMARY KEY,
  pattern TEXT NOT NULL,
  reason TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  vector BLOB NOT NULL
);

CREATE TABLE IF NOT EXISTS skills (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  verified INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS skill_versions (
  id TEXT PRIMARY KEY,
  skill_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  successes INTEGER NOT NULL DEFAULT 0,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS coral_log (
  version INTEGER PRIMARY KEY,
  platform TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  action TEXT NOT NULL,
  outcome TEXT NOT NULL,
  scope_hash TEXT,
  auto_approved INTEGER NOT NULL DEFAULT 0,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  monitor TEXT NOT NULL,
  severity TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_events (
  id TEXT PRIMARY KEY,
  alert_id TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS errors (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  source TEXT NOT NULL,
  severity TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provider_health (
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  failure_count INTEGER NOT NULL,
  blocked_until TEXT,
  PRIMARY KEY (provider, model)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const ATHENA_FTS_SQL = "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(body, content='messages', content_rowid='rowid')";
