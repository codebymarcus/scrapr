// test/profiles.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContentType, hostMatch } from "../src/profiles/profile.mjs";
import batcave from "../src/profiles/batcave.mjs";
import generic from "../src/profiles/generic.mjs";

test("hostMatch: exact host and subdomain, not others, safe on bad URL", () => {
  const m = hostMatch("batcave.biz");
  assert.equal(m("https://batcave.biz/event/x/1"), true);
  assert.equal(m("https://www.batcave.biz/x"), true);
  assert.equal(m("https://notbatcave.biz/x"), false);
  assert.equal(m("https://example.com/x"), false);
  assert.equal(m("not a url"), false);
});

test("batcave profile: matches batcave, image content, chapter-aware pipeline", () => {
  assert.equal(batcave.match("https://batcave.biz/event/ultimate-marvel/395"), true);
  assert.equal(batcave.match("https://example.com/x"), false);
  assert.equal(batcave.contentType, ContentType.IMAGE);
  assert.deepEqual(batcave.pipeline.map((p) => p.mechanism), ["chapter-aware"]);
  assert.equal(batcave.pipeline[0].maxAttempts, 1);
});

test("generic profile: matches everything, image content, current pipeline", () => {
  assert.equal(generic.match("https://anything.example/x"), true);
  assert.equal(generic.contentType, ContentType.IMAGE);
  assert.deepEqual(generic.pipeline.map((p) => p.mechanism), ["current"]);
  assert.equal(generic.pipeline[0].maxAttempts, 2);
});
