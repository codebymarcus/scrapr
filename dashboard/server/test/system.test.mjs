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

test("GET /api/drive/status reports disconnected with an authorize hint", async () => {
  const app = buildApp({
    driveStatus: () => ({
      connected: false,
      credentialsPath: "/x/credentials.json",
      tokenPath: "/x/token.json",
    }),
  });
  const res = await app.inject({ method: "GET", url: "/api/drive/status" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.connected, false);
  assert.equal(body.credentialsPath, "/x/credentials.json");
  assert.equal(body.tokenPath, "/x/token.json");
  assert.match(body.hint, /authorize\.mjs/);
  await app.close();
});

test("GET /api/drive/status reports connected with no authorize hint", async () => {
  const app = buildApp({
    driveStatus: () => ({
      connected: true,
      credentialsPath: "/x/credentials.json",
      tokenPath: "/x/token.json",
    }),
  });
  const res = await app.inject({ method: "GET", url: "/api/drive/status" });
  const body = res.json();
  assert.equal(body.connected, true);
  assert.doesNotMatch(body.hint ?? "", /authorize\.mjs/);
  await app.close();
});

test("default driveStatus resolves absolute paths from engine DEFAULTS", async () => {
  const app = buildApp();
  const res = await app.inject({ method: "GET", url: "/api/drive/status" });
  const body = res.json();
  assert.equal(typeof body.connected, "boolean");
  assert.match(body.credentialsPath, /^\//);
  assert.match(body.credentialsPath, /credentials\.json$/);
  assert.match(body.tokenPath, /^\//);
  assert.match(body.tokenPath, /token\.json$/);
  await app.close();
});
