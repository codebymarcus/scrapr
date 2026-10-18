export const MIGRATIONS = [
  {
    id: "001_initial_schema",
    sql: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        recipe_json TEXT NOT NULL,
        created_at TEXT,
        updated_at TEXT
      );

      CREATE TABLE runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER REFERENCES projects(id),
        label TEXT,
        state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'stopped', 'done', 'failed')),
        created_at TEXT,
        started_at TEXT,
        finished_at TEXT
      );

      CREATE TABLE run_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id INTEGER NOT NULL REFERENCES runs(id),
        url TEXT NOT NULL,
        name TEXT,
        status TEXT DEFAULT '',
        reason TEXT,
        saved INTEGER,
        total INTEGER,
        needs_review INTEGER DEFAULT 0,
        position INTEGER
      );
    `,
  },
  {
    id: "002_secrets",
    sql: `
      CREATE TABLE secrets (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT
      );
    `,
  },
  {
    id: "003_run_overrides",
    sql: `ALTER TABLE runs ADD COLUMN overrides_json TEXT;`,
  },
  {
    id: "004_item_upload",
    sql: `
      ALTER TABLE run_items ADD COLUMN output_name TEXT;
      ALTER TABLE run_items ADD COLUMN uploaded_at TEXT;
      ALTER TABLE run_items ADD COLUMN drive_link TEXT;
    `,
  },
];

export function migrate(db, migrations = MIGRATIONS) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  const applied = new Set(
    db.prepare("SELECT id FROM _migrations").all().map((r) => r.id),
  );
  const record = db.prepare("INSERT INTO _migrations (id) VALUES (?)");
  for (const { id, sql } of migrations) {
    if (applied.has(id)) continue;
    db.transaction(() => {
      db.exec(sql);
      record.run(id);
    })();
  }
}
