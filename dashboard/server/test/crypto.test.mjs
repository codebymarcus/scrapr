import { test } from "node:test";
import assert from "node:assert/strict";
import { keyFromEnv, encryptSecret, decryptSecret } from "../src/secrets/crypto.mjs";

const key = keyFromEnv({ APP_SECRET_KEY: Buffer.alloc(32, 7).toString("base64") });

test("encrypt/decrypt round-trips", () => {
  assert.equal(decryptSecret(encryptSecret("hello", key), key), "hello");
});

test("wrong key throws", () => {
  const other = keyFromEnv({ APP_SECRET_KEY: Buffer.alloc(32, 9).toString("base64") });
  assert.throws(() => decryptSecret(encryptSecret("hi", key), other));
});

test("tampered blob throws", () => {
  const blob = encryptSecret("hi", key);
  assert.throws(() => decryptSecret(blob.slice(0, -2) + "xy", key));
});

test("malformed blob throws", () => {
  assert.throws(() => decryptSecret("garbage", key));
});

test("missing or bad env yields null without throwing", () => {
  assert.equal(keyFromEnv({}), null);
  assert.equal(keyFromEnv({ APP_SECRET_KEY: "not-base64-32-bytes" }), null);
});
