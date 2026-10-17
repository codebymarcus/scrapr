import { test } from "node:test";
import assert from "node:assert/strict";
import { buildApp } from "../src/app.mjs";
import { createDriveAuth } from "../src/drive-auth.mjs";

function fakeDriveAuth({ configured = true, exchange } = {}) {
  const calls = { exchange: [], disconnect: 0 };
  return {
    calls,
    isConfigured: () => configured,
    status: () =>
      configured
        ? { configured: true, connected: false, reason: "ok" }
        : { configured: false, connected: false, reason: "not-configured" },
    authUrl: (state) => `https://accounts.example/auth?state=${encodeURIComponent(state)}`,
    exchangeCode: async (code) => {
      calls.exchange.push(code);
      if (exchange) await exchange(code);
    },
    disconnect: () => {
      calls.disconnect += 1;
    },
  };
}

// Runs GET /api/drive/connect and returns the state + cookie the browser would hold.
async function connect(app) {
  const res = await app.inject({ method: "GET", url: "/api/drive/connect" });
  assert.equal(res.statusCode, 200);
  const state = new URL(res.json().url).searchParams.get("state");
  const cookie = String(res.headers["set-cookie"]).split(";")[0];
  return { state, cookie };
}

test("status reflects the driveAuth status and adds a hint", async () => {
  const app = buildApp({ driveAuth: fakeDriveAuth() });
  const res = await app.inject({ method: "GET", url: "/api/drive/status" });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.connected, false);
  assert.equal(body.configured, true);
  assert.equal(body.reason, "ok");
  assert.equal(typeof body.hint, "string");
  await app.close();
});

test("status hint differs for each reason", async () => {
  const mk = (s) =>
    buildApp({ driveAuth: { ...fakeDriveAuth(), status: () => s } });
  const hints = new Set();
  for (const s of [
    { configured: false, connected: false, reason: "not-configured" },
    { configured: true, connected: false, reason: "needs-reconnect" },
    { configured: true, connected: true, reason: "ok" },
    { configured: true, connected: false, reason: "ok" },
  ]) {
    const app = mk(s);
    const res = await app.inject({ method: "GET", url: "/api/drive/status" });
    hints.add(res.json().hint);
    await app.close();
  }
  assert.equal(hints.size, 4);
});

test("connect returns the consent url when configured", async () => {
  const app = buildApp({ driveAuth: fakeDriveAuth() });
  const res = await app.inject({ method: "GET", url: "/api/drive/connect" });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().url, /^https:\/\/accounts\.example\/auth\?state=.+/);
  assert.match(String(res.headers["set-cookie"]), /HttpOnly/);
  assert.match(String(res.headers["set-cookie"]), /SameSite=Lax/);
  await app.close();
});

test("connect returns 409 when not configured", async () => {
  const app = buildApp({ driveAuth: fakeDriveAuth({ configured: false }) });
  const res = await app.inject({ method: "GET", url: "/api/drive/connect" });
  assert.equal(res.statusCode, 409);
  assert.equal(typeof res.json().error, "string");
  await app.close();
});

test("callback with error=access_denied redirects without exchanging", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const res = await app.inject({ method: "GET", url: "/api/drive/callback?error=access_denied" });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/settings\?drive=denied/);
  assert.deepEqual(da.calls.exchange, []);
  await app.close();
});

test("callback with no code redirects without exchanging", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const res = await app.inject({ method: "GET", url: "/api/drive/callback" });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/settings\?drive=error/);
  assert.deepEqual(da.calls.exchange, []);
  await app.close();
});

test("callback with a code and valid state exchanges and redirects", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const { state, cookie } = await connect(app);
  const res = await app.inject({
    method: "GET",
    url: `/api/drive/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/settings\?drive=connected/);
  assert.deepEqual(da.calls.exchange, ["abc"]);
  await app.close();
});

test("callback rejects a missing or unknown state (CSRF)", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const { cookie } = await connect(app);
  for (const url of [
    "/api/drive/callback?code=abc",
    "/api/drive/callback?code=abc&state=forged",
  ]) {
    const res = await app.inject({ method: "GET", url, headers: { cookie } });
    assert.equal(res.statusCode, 302);
    assert.match(res.headers.location, /^\/settings\?drive=error/);
  }
  assert.deepEqual(da.calls.exchange, []);
  await app.close();
});

test("callback rejects a valid state without the matching browser cookie", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const { state } = await connect(app);
  const res = await app.inject({
    method: "GET",
    url: `/api/drive/callback?code=abc&state=${encodeURIComponent(state)}`,
  });
  assert.match(res.headers.location, /^\/settings\?drive=error/);
  assert.deepEqual(da.calls.exchange, []);
  await app.close();
});

test("state is single-use", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const { state, cookie } = await connect(app);
  const url = `/api/drive/callback?code=abc&state=${encodeURIComponent(state)}`;
  await app.inject({ method: "GET", url, headers: { cookie } });
  const again = await app.inject({ method: "GET", url, headers: { cookie } });
  assert.match(again.headers.location, /^\/settings\?drive=error/);
  assert.deepEqual(da.calls.exchange, ["abc"]);
  await app.close();
});

test("callback does not 500 when the exchange fails", async () => {
  const da = fakeDriveAuth({
    exchange: async () => {
      throw new Error("invalid_grant");
    },
  });
  const app = buildApp({ driveAuth: da });
  const { state, cookie } = await connect(app);
  const res = await app.inject({
    method: "GET",
    url: `/api/drive/callback?code=abc&state=${encodeURIComponent(state)}`,
    headers: { cookie },
  });
  assert.equal(res.statusCode, 302);
  assert.match(res.headers.location, /^\/settings\?drive=error/);
  await app.close();
});

test("disconnect calls driveAuth.disconnect", async () => {
  const da = fakeDriveAuth();
  const app = buildApp({ driveAuth: da });
  const res = await app.inject({ method: "POST", url: "/api/drive/disconnect" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { disconnected: true });
  assert.equal(da.calls.disconnect, 1);
  await app.close();
});

test("a server with no key still answers /api/drive/status and /api/health", async () => {
  const driveAuth = createDriveAuth({
    store: { getSecret: () => null, setSecret() {}, deleteSecret() {} },
    key: null,
    clientId: "",
    clientSecret: "",
    redirectUri: "http://localhost/cb",
  });
  const app = buildApp({ driveAuth });
  const status = await app.inject({ method: "GET", url: "/api/drive/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, false);
  assert.equal(status.json().reason, "not-configured");
  const health = await app.inject({ method: "GET", url: "/api/health" });
  assert.deepEqual(health.json(), { ok: true });
  const connectRes = await app.inject({ method: "GET", url: "/api/drive/connect" });
  assert.equal(connectRes.statusCode, 409);
  await app.close();
});

test("a server built with no driveAuth at all still serves health and reports not configured", async () => {
  const app = buildApp();
  assert.equal((await app.inject({ method: "GET", url: "/api/health" })).statusCode, 200);
  const status = await app.inject({ method: "GET", url: "/api/drive/status" });
  assert.equal(status.statusCode, 200);
  assert.equal(status.json().configured, false);
  await app.close();
});
