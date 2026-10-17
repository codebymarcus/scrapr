import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createDriveAuth } from "../src/drive-auth.mjs";

function fakeStore() {
  const m = new Map();
  return {
    getSecret: (k) => (m.has(k) ? m.get(k) : null),
    setSecret: (k, v) => void m.set(k, v),
    deleteSecret: (k) => void m.delete(k),
  };
}

// A fake googleapis OAuth2 client; records constructor args.
function fakeFactory(calls = []) {
  return (id, secret, redirect) => {
    calls.push({ id, secret, redirect });
    return {
      generateAuthUrl(opts) {
        const q = new URLSearchParams({
          access_type: opts.access_type,
          prompt: opts.prompt,
          scope: opts.scope.join(" "),
          state: opts.state,
        });
        return `https://accounts.example/auth?${q}`;
      },
      async getToken(code) {
        calls.push({ code });
        return { tokens: { refresh_token: "r" } };
      },
    };
  };
}

const base = () => ({
  store: fakeStore(),
  key: randomBytes(32),
  clientId: "cid",
  clientSecret: "csecret",
  redirectUri: "http://localhost:5174/api/drive/callback",
  oauthFactory: fakeFactory(),
});

test("not configured without a key", () => {
  const auth = createDriveAuth({ ...base(), key: null });
  assert.equal(auth.isConfigured(), false);
  assert.deepEqual(auth.status(), { configured: false, connected: false, reason: "not-configured" });
  assert.equal(auth.loadAuthConfig(), null);
  assert.equal(auth.getToken(), null);
});

test("not configured without client id or secret", () => {
  assert.equal(createDriveAuth({ ...base(), clientId: "" }).isConfigured(), false);
  assert.equal(createDriveAuth({ ...base(), clientSecret: undefined }).isConfigured(), false);
});

test("configured but not yet connected", () => {
  const auth = createDriveAuth(base());
  assert.equal(auth.isConfigured(), true);
  assert.deepEqual(auth.status(), { configured: true, connected: false, reason: "ok" });
  assert.equal(auth.loadAuthConfig(), null);
});

test("exchangeCode stores an encrypted token and connects", async () => {
  const b = base();
  const auth = createDriveAuth(b);
  await auth.exchangeCode("the-code");
  const raw = b.store.getSecret("drive_token");
  assert.ok(raw && !raw.includes("refresh_token"), "stored blob is encrypted");
  assert.deepEqual(auth.getToken(), { refresh_token: "r" });
  assert.deepEqual(auth.status(), { configured: true, connected: true, reason: "ok" });
  assert.deepEqual(auth.loadAuthConfig(), {
    clientId: "cid",
    clientSecret: "csecret",
    token: { refresh_token: "r" },
  });
});

test("token undecryptable with a different key -> needs-reconnect, no throw", async () => {
  const b = base();
  await createDriveAuth(b).exchangeCode("c");
  const other = createDriveAuth({ ...b, key: randomBytes(32) });
  assert.equal(other.getToken(), null);
  assert.deepEqual(other.status(), { configured: true, connected: false, reason: "needs-reconnect" });
  assert.equal(other.loadAuthConfig(), null);
});

test("disconnect removes the token", async () => {
  const b = base();
  const auth = createDriveAuth(b);
  await auth.exchangeCode("c");
  auth.disconnect();
  assert.equal(b.store.getSecret("drive_token"), null);
  assert.equal(auth.status().connected, false);
  assert.equal(auth.status().reason, "ok");
});

test("authUrl carries scope, offline access, consent prompt and state", () => {
  const calls = [];
  const auth = createDriveAuth({ ...base(), oauthFactory: fakeFactory(calls) });
  const url = new URL(auth.authUrl("s"));
  assert.equal(url.searchParams.get("scope"), "https://www.googleapis.com/auth/drive.file");
  assert.equal(url.searchParams.get("access_type"), "offline");
  assert.equal(url.searchParams.get("prompt"), "consent");
  assert.equal(url.searchParams.get("state"), "s");
  assert.deepEqual(calls[0], {
    id: "cid",
    secret: "csecret",
    redirect: "http://localhost:5174/api/drive/callback",
  });
});

test("exchangeCode rejects a response with no tokens and stores nothing", async () => {
  const b = base();
  const auth = createDriveAuth({
    ...b,
    oauthFactory: () => ({ getToken: async () => ({ tokens: null }) }),
  });
  await assert.rejects(() => auth.exchangeCode("c"));
  assert.equal(b.store.getSecret("drive_token"), null);
});
