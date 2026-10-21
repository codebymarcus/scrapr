import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveRunDriveAuth } from "../src/resolve-drive-auth.mjs";

const creds = (id) => ({ clientId: "cid", clientSecret: "sec", token: { sub: id } });

// A fake driveAuth service backed by a map of connected accounts.
function fakeDriveAuth(accounts) {
  return {
    listAccounts: () => accounts.map(({ id, connected }) => ({ id, label: id, email: `${id}@x`, connected })),
    loadAuthConfig: (id) => {
      const acc = accounts.find((a) => a.id === id);
      return acc && acc.connected ? creds(id) : null;
    },
  };
}

test("driveAccountId set + available -> that account's creds", () => {
  const svc = fakeDriveAuth([{ id: "a", connected: true }, { id: "b", connected: true }]);
  assert.deepEqual(resolveRunDriveAuth(svc, { driveAccountId: "b" }), creds("b"));
});

test("driveAccountId set + gone -> null (no fallback to another account)", () => {
  const svc = fakeDriveAuth([{ id: "a", connected: true }]);
  assert.equal(resolveRunDriveAuth(svc, { driveAccountId: "gone" }), null);
});

test("no driveAccountId + exactly one connected -> that account's creds (back-compat)", () => {
  const svc = fakeDriveAuth([{ id: "a", connected: true }, { id: "b", connected: false }]);
  assert.deepEqual(resolveRunDriveAuth(svc, {}), creds("a"));
  assert.deepEqual(resolveRunDriveAuth(svc, undefined), creds("a"));
});

test("no driveAccountId + zero connected -> null", () => {
  const svc = fakeDriveAuth([{ id: "a", connected: false }]);
  assert.equal(resolveRunDriveAuth(svc, {}), null);
});

test("no driveAccountId + multiple connected -> null (nothing to guess)", () => {
  const svc = fakeDriveAuth([{ id: "a", connected: true }, { id: "b", connected: true }]);
  assert.equal(resolveRunDriveAuth(svc, {}), null);
});

test("missing driveAuth service or methods -> null", () => {
  assert.equal(resolveRunDriveAuth(undefined, { driveAccountId: "a" }), null);
  assert.equal(resolveRunDriveAuth({}, { driveAccountId: "a" }), null);
  assert.equal(resolveRunDriveAuth({}, {}), null);
});
