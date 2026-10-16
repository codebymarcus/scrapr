import { test } from "node:test";
import assert from "node:assert/strict";
import { recipeToProfile, imageRulesFromRecipe, boundResolver } from "../src/recipes/recipe.mjs";

test("recipeToProfile maps an image recipe to a profile shape", () => {
  const p = recipeToProfile({ name: "comic", contentType: "image",
    match: { hosts: ["batcave.biz"] },
    image: { pipeline: [{ mechanism: "chapter-aware" }], rules: { minWidth: 500 } } });
  assert.equal(p.name, "comic");
  assert.equal(p.contentType, "image");
  assert.equal(p.match("https://batcave.biz/x"), true);
  assert.equal(p.match("https://other.com/x"), false);
  assert.deepEqual(p.pipeline, [{ mechanism: "chapter-aware" }]);
});

test("recipeToProfile defaults match to always-true when no hosts", () => {
  const p = recipeToProfile({ name: "any", contentType: "text", text: { mode: "selector" } });
  assert.equal(p.match("https://anything/x"), true);
  assert.deepEqual(p.metadata, {});
});

test("boundResolver ignores url and returns the recipe's profile", () => {
  const r = { name: "x", contentType: "image", image: { pipeline: [] } };
  const resolve = boundResolver(r);
  assert.equal(resolve("https://a").name, "x");
  assert.equal(resolve("https://b").name, "x");
});

test("imageRulesFromRecipe returns rules or null", () => {
  assert.deepEqual(imageRulesFromRecipe({ image: { rules: { minWidth: 10 } } }), { minWidth: 10 });
  assert.equal(imageRulesFromRecipe({ contentType: "text" }), null);
});
