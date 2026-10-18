function now() {
  return new Date().toISOString();
}

function projectFromRow(row) {
  if (!row) return null;
  const { recipe_json: recipeJson, ...rest } = row;
  return { ...rest, recipe: JSON.parse(recipeJson) };
}

// Parses overrides_json into an `overrides` object (null when none were set).
function runFromRow(row) {
  if (!row) return null;
  const { overrides_json: overridesJson, ...rest } = row;
  return { ...rest, overrides: overridesJson ? JSON.parse(overridesJson) : null };
}

export function createStore(db) {
  const q = {
    insertProject: db.prepare(
      "INSERT INTO projects (name, recipe_json, created_at, updated_at) VALUES (?, ?, ?, ?)",
    ),
    listProjects: db.prepare("SELECT * FROM projects ORDER BY id ASC"),
    getProject: db.prepare("SELECT * FROM projects WHERE id = ?"),
    updateProject: db.prepare(
      "UPDATE projects SET name = ?, recipe_json = ?, updated_at = ? WHERE id = ?",
    ),
    deleteProject: db.prepare("DELETE FROM projects WHERE id = ?"),

    insertRun: db.prepare(
      "INSERT INTO runs (project_id, label, state, created_at, overrides_json) VALUES (?, ?, 'queued', ?, ?)",
    ),
    listRuns: db.prepare("SELECT * FROM runs ORDER BY id ASC"),
    getRun: db.prepare("SELECT * FROM runs WHERE id = ?"),
    setRunState: db.prepare(
      `UPDATE runs SET state = ?,
         started_at = COALESCE(?, started_at),
         finished_at = COALESCE(?, finished_at)
       WHERE id = ?`,
    ),
    nextQueuedRun: db.prepare(
      "SELECT * FROM runs WHERE state = 'queued' ORDER BY created_at ASC, id ASC LIMIT 1",
    ),
    deleteRunItems: db.prepare("DELETE FROM run_items WHERE run_id = ?"),
    deleteRun: db.prepare("DELETE FROM runs WHERE id = ?"),
    failRunningRuns: db.prepare(
      `UPDATE runs SET state = 'failed', finished_at = COALESCE(finished_at, ?)
       WHERE state = 'running'`,
    ),

    maxPosition: db.prepare(
      "SELECT COALESCE(MAX(position), -1) AS max FROM run_items WHERE run_id = ?",
    ),
    insertItem: db.prepare(
      "INSERT INTO run_items (run_id, url, name, status, position) VALUES (?, ?, ?, '', ?)",
    ),
    listItems: db.prepare("SELECT * FROM run_items WHERE run_id = ? ORDER BY position ASC"),
    loadItems: db.prepare(
      "SELECT id, url, name, status FROM run_items WHERE run_id = ? ORDER BY position ASC",
    ),
    setItemStatus: db.prepare("UPDATE run_items SET status = ? WHERE id = ?"),
    setItemReason: db.prepare("UPDATE run_items SET reason = ? WHERE id = ?"),
    setItemResult: db.prepare(
      "UPDATE run_items SET saved = ?, total = ?, needs_review = ? WHERE id = ?",
    ),

    getSecret: db.prepare("SELECT value FROM secrets WHERE key = ?"),
    upsertSecret: db.prepare(
      "INSERT INTO secrets (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ),
    deleteSecret: db.prepare("DELETE FROM secrets WHERE key = ?"),
  };

  // Each item is a URL string or a { url, name } row (name from a sheet's
  // name/title column). A missing name is stored as null.
  const addItemsTx = db.transaction((runId, items) => {
    let position = q.maxPosition.get(runId).max;
    for (const item of items) {
      position += 1;
      const url = typeof item === "string" ? item : item.url;
      const name = typeof item === "string" ? null : (item.name ?? null);
      q.insertItem.run(runId, url, name, position);
    }
  });

  // Delete a run and its items atomically (items first: no orphaned rows).
  const deleteRunTx = db.transaction((id) => {
    q.deleteRunItems.run(id);
    q.deleteRun.run(id);
  });

  function getProject(id) {
    return projectFromRow(q.getProject.get(id));
  }

  function getRun(id) {
    return runFromRow(q.getRun.get(id));
  }

  return {
    // Job-source contract (synchronous).
    loadItems(runId) {
      return q.loadItems.all(runId);
    },
    setItemStatus(id, value) {
      q.setItemStatus.run(value, id);
    },
    setItemReason(id, text) {
      q.setItemReason.run(text, id);
    },

    // Projects.
    createProject({ name, recipe }) {
      const ts = now();
      const info = q.insertProject.run(name, JSON.stringify(recipe), ts, ts);
      return getProject(Number(info.lastInsertRowid));
    },
    listProjects() {
      return q.listProjects.all().map(projectFromRow);
    },
    getProject,
    updateProject(id, patch) {
      const current = getProject(id);
      if (!current) return null;
      const name = patch.name ?? current.name;
      const recipe = patch.recipe ?? current.recipe;
      q.updateProject.run(name, JSON.stringify(recipe), now(), id);
      return getProject(id);
    },
    deleteProject(id) {
      q.deleteProject.run(id);
    },

    // Runs and items.
    createRun({ projectId, label, overrides }) {
      const info = q.insertRun.run(projectId, label, now(), JSON.stringify(overrides ?? null));
      return getRun(Number(info.lastInsertRowid));
    },
    listRuns() {
      return q.listRuns.all().map(runFromRow);
    },
    getRun,
    // times: { startedAt?, finishedAt? } as ISO strings; omitted fields are left unchanged.
    setRunState(id, state, times = {}) {
      q.setRunState.run(state, times.startedAt ?? null, times.finishedAt ?? null, id);
    },
    // items: URL strings and/or { url, name } rows.
    addItems(runId, items) {
      addItemsTx(runId, items);
    },
    listItems(runId) {
      return q.listItems.all(runId);
    },
    setItemResult(id, { saved, total, needsReview }) {
      q.setItemResult.run(saved, total, needsReview ? 1 : 0, id);
    },
    nextQueuedRun() {
      return runFromRow(q.nextQueuedRun.get());
    },
    deleteRun(id) {
      deleteRunTx(id);
    },
    // Recovery: a run left in "running" after a crash/restart has no live
    // process, so mark it failed. Returns how many were reconciled.
    failInterruptedRuns() {
      return q.failRunningRuns.run(now()).changes;
    },

    // Secrets: opaque (already-encrypted) strings; the store does no crypto.
    getSecret(key) {
      return q.getSecret.get(key)?.value ?? null;
    },
    setSecret(key, value) {
      q.upsertSecret.run(key, value, now());
    },
    deleteSecret(key) {
      q.deleteSecret.run(key);
    },
  };
}
