import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.mjs";

test("GET /api/health returns ok", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/health" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
  await app.close();
});

// Drive status/connect/callback/disconnect are covered in drive-routes.test.mjs.
