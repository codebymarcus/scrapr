import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { openDb } from "../src/db/db.mjs";
import { migrate } from "../src/db/migrations.mjs";
import { createStore } from "../src/db/store.mjs";
import { encryptSecret } from "../src/secrets/crypto.mjs";
import { createDriveAuth } from "../src/drive-auth.mjs";

function b64url(obj) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

// A minimal, decodable id_token: header.payload.signature, payload carries
// the account sub and email.
function idToken(payload) {
  return `${b64url({ alg: "none", typ: "JWT" })}.${b64url(payload)}.sig`;
}

function makeStore() {
  const db = openDb();
  migrate(db);
  return createStore(db);
}

// A fake googleapis OAuth2 client. getToken returns tokens carrying an
// id_token whose payload is whatever `factory.payload` currently is, and an
// access_token that changes on each call so a refresh is observable.
function fakeFactory(payload) {
  let n = 0;
  const calls = [];
  const factory = (id, secret, redirect) => {
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
        n += 1;
        return {
          tokens: {
            access_token: `at-${n}`,
            refresh_token: "rt",
            id_token: idToken(factory.payload),
          },
        };
      },
    };
  };
  factory.payload = payload;
  factory.calls = calls;
  return factory;
}

function base(store, factory, key = randomBytes(32)) {
  return {
    store,
    key,
    clientId: "cid",
    clientSecret: "csecret",
    redirectUri: "http://localhost:5174/api/drive/callback",
    oauthFactory: factory,
  };
}

test("isConfigured unchanged: false without a key", () => {
  const auth = createDriveAuth({ ...base(makeStore(), fakeFactory({})), key: null });
  assert.equal(auth.isConfigured(), false);
});

test("authUrl now requests openid and email alongside drive.file", () => {
  const auth = createDriveAuth(base(makeStore(), fakeFactory({})));
  const url = new URL(auth.authUrl("s"));
  const scope = url.searchParams.get("scope");
  assert.ok(scope.includes("https://www.googleapis.com/auth/drive.file"));
  assert.ok(scope.split(" ").includes("openid"));
  assert.ok(scope.split(" ").includes("email"));
  assert.equal(url.searchParams.get("state"), "s");
});

test("first exchangeCode inserts an account keyed by sub, label=email", async () => {
  const store = makeStore();
  const factory = fakeFactory({ sub: "sub-1", email: "a@example.com" });
  const auth = createDriveAuth(base(store, factory));
  const id = await auth.exchangeCode("the-code");
  assert.equal(id, "sub-1");
  const accts = auth.listAccounts();
  assert.equal(accts.length, 1);
  assert.deepEqual(accts[0], {
    id: "sub-1",
    label: "a@example.com",
    email: "a@example.com",
    connected: true,
  });
  // stored blob is encrypted, not plaintext tokens
  const row = store.getDriveAccount("sub-1");
  assert.ok(row.token && !row.token.includes("refresh_token"));
});

test("second exchangeCode for the same sub updates in place, operator label preserved", async () => {
  const store = makeStore();
  const factory = fakeFactory({ sub: "sub-1", email: "a@example.com" });
  const auth = createDriveAuth(base(store, factory));
  await auth.exchangeCode("c1");
  const first = auth.getToken("sub-1");
  auth.renameAccount("sub-1", "Operator Label");

  factory.payload = { sub: "sub-1", email: "renamed@example.com" };
  const id = await auth.exchangeCode("c2");

  assert.equal(id, "sub-1");
  const accts = auth.listAccounts();
  assert.equal(accts.length, 1, "still one account");
  assert.equal(accts[0].label, "Operator Label", "operator label preserved");
  assert.equal(accts[0].email, "renamed@example.com", "email refreshed");
  const second = auth.getToken("sub-1");
  assert.notEqual(second.access_token, first.access_token, "token refreshed");
});

test("exchangeCode with targetAccountId updates that row and sets its sub/email", async () => {
  const store = makeStore();
  const key = randomBytes(32);
  // A pre-existing card-scoped row with a placeholder (undecryptable) token.
  store.upsertDriveAccount({
    id: "card-1",
    sub: null,
    label: "Card One",
    email: null,
    token: "placeholder-not-decryptable",
  });
  const factory = fakeFactory({ sub: "sub-9", email: "nine@example.com" });
  const auth = createDriveAuth(base(store, factory, key));

  const id = await auth.exchangeCode("c", { targetAccountId: "card-1" });
  assert.equal(id, "card-1");
  const row = store.getDriveAccount("card-1");
  assert.equal(row.label, "Card One", "label preserved");
  assert.equal(row.sub, "sub-9");
  assert.equal(row.email, "nine@example.com");
  assert.equal(auth.listAccounts().find((a) => a.id === "card-1").connected, true);
  // did not create a second account keyed by sub
  assert.equal(store.getDriveAccountBySub("sub-9").id, "card-1");
});

test("reconnecting a card into a sub already owned by another card throws and mutates nothing", async () => {
  const store = makeStore();
  const key = randomBytes(32);
  const factory = fakeFactory({ sub: "sub-G", email: "g@example.com" });
  const auth = createDriveAuth(base(store, factory, key));

  // Card G is connected and owns sub-G.
  await auth.exchangeCode("cg");
  const gBefore = { ...store.getDriveAccount("sub-G") };

  // Card M exists with its own token/sub; operator reconnects it but signs in
  // as sub-G (already owned by card G).
  store.upsertDriveAccount({
    id: "card-M",
    sub: "sub-M",
    label: "Card M",
    email: "m@example.com",
    token: "m-token-blob",
  });
  const mBefore = { ...store.getDriveAccount("card-M") };

  await assert.rejects(
    () => auth.exchangeCode("cm", { targetAccountId: "card-M" }),
    /already connected/,
  );

  assert.deepEqual(store.getDriveAccount("sub-G"), gBefore, "card G untouched");
  assert.deepEqual(store.getDriveAccount("card-M"), mBefore, "card M untouched");
  assert.equal(store.listDriveAccounts().length, 2);
});

test("loadAuthConfig round-trips the decrypted token and is null for unknown id", async () => {
  const store = makeStore();
  const factory = fakeFactory({ sub: "sub-1", email: "a@example.com" });
  const auth = createDriveAuth(base(store, factory));
  await auth.exchangeCode("c");
  const cfg = auth.loadAuthConfig("sub-1");
  assert.deepEqual(cfg, {
    clientId: "cid",
    clientSecret: "csecret",
    token: auth.getToken("sub-1"),
  });
  assert.equal(cfg.token.refresh_token, "rt");
  assert.equal(auth.loadAuthConfig("no-such-id"), null);
});

test("disconnect and renameAccount affect only the targeted row", async () => {
  const store = makeStore();
  const factory = fakeFactory({ sub: "sub-1", email: "a@example.com" });
  const auth = createDriveAuth(base(store, factory));
  await auth.exchangeCode("c1");
  factory.payload = { sub: "sub-2", email: "b@example.com" };
  await auth.exchangeCode("c2");

  auth.renameAccount("sub-1", "Renamed One");
  assert.equal(store.getDriveAccount("sub-1").label, "Renamed One");
  assert.equal(store.getDriveAccount("sub-2").label, "b@example.com");

  auth.disconnect("sub-1");
  assert.equal(store.getDriveAccount("sub-1"), null);
  assert.equal(store.getDriveAccount("sub-2").label, "b@example.com");
  assert.equal(auth.listAccounts().length, 1);
});

test("ensureMigratedLegacyAccount seeds one account from the legacy secret, idempotently, and removes it", () => {
  const store = makeStore();
  const key = randomBytes(32);
  const factory = fakeFactory({});
  const auth = createDriveAuth(base(store, factory, key));
  const legacyBlob = encryptSecret(JSON.stringify({ refresh_token: "legacy" }), key);
  store.setSecret("drive_token", legacyBlob);

  auth.ensureMigratedLegacyAccount();

  const rows = store.listDriveAccounts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sub, null);
  assert.equal(rows[0].email, null);
  assert.ok(rows[0].label, "has a generic label");
  assert.equal(rows[0].token, legacyBlob, "reused the blob as-is");
  assert.equal(store.getSecret("drive_token"), null, "secret removed");
  // migrated account is connected (blob decryptable with the same key)
  assert.equal(auth.listAccounts()[0].connected, true);

  // idempotent: calling again does nothing
  auth.ensureMigratedLegacyAccount();
  assert.equal(store.listDriveAccounts().length, 1);
});

test("ensureMigratedLegacyAccount does nothing when a drive_accounts row already exists", () => {
  const store = makeStore();
  const factory = fakeFactory({});
  const auth = createDriveAuth(base(store, factory));
  store.upsertDriveAccount({ id: "existing", sub: "s", label: "L", email: "e", token: "t" });
  store.setSecret("drive_token", "legacy-blob");

  auth.ensureMigratedLegacyAccount();

  assert.equal(store.listDriveAccounts().length, 1);
  assert.equal(store.getDriveAccount("existing").id, "existing");
  assert.equal(store.getSecret("drive_token"), "legacy-blob", "secret untouched");
});

test("an account whose blob won't decrypt shows connected:false without throwing", () => {
  const store = makeStore();
  const factory = fakeFactory({});
  const auth = createDriveAuth(base(store, factory));
  store.upsertDriveAccount({
    id: "bad",
    sub: "s",
    label: "Bad",
    email: "b@example.com",
    token: "not-a-valid-blob",
  });
  const accts = auth.listAccounts();
  const bad = accts.find((a) => a.id === "bad");
  assert.equal(bad.connected, false);
  assert.equal(auth.getToken("bad"), null);
});

test("fresh exchangeCode with no sub in the id_token throws and inserts no row", async () => {
  const store = makeStore();
  const factory = fakeFactory({ email: "no-sub@example.com" }); // payload lacks sub
  const auth = createDriveAuth(base(store, factory));
  await assert.rejects(() => auth.exchangeCode("c"), /account identity/);
  assert.equal(store.listDriveAccounts().length, 0);
});

test("exchangeCode rejects a response with no tokens and stores nothing", async () => {
  const store = makeStore();
  const auth = createDriveAuth({
    ...base(store, fakeFactory({})),
    oauthFactory: () => ({ getToken: async () => ({ tokens: null }) }),
  });
  await assert.rejects(() => auth.exchangeCode("c"));
  assert.equal(store.listDriveAccounts().length, 0);
});
