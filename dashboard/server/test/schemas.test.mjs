import { test } from "node:test";
import assert from "node:assert/strict";
import {
  recipeSchema,
  imageRulesSchema,
  createProjectSchema,
  updateProjectSchema,
  createRunSchema,
  enqueueSchema,
  previewSchema,
  parseOr400,
} from "../src/schemas.mjs";

const imageRecipe = {
  name: "manga-site",
  contentType: "image",
  match: { hosts: ["example.com"] },
  image: {
    pipeline: [{ mechanism: "fetch", maxAttempts: 3, params: { timeout: 1000 } }],
    rules: { minWidth: 400, excludeUrl: "ads", position: { from: 1, to: 20 } },
    expectCount: 20,
  },
  output: { cbz: true, pdf: false, quality: 80, format: "jpeg", drive: true },
};

const textRecipe = {
  name: "blog",
  contentType: "text",
  text: {
    mode: "selector",
    selector: "article",
    fields: [{ name: "title", selector: "h1", attr: "text", many: false }],
    patterns: ["foo"],
  },
  metadata: { title: "x" },
};

test("a valid image recipe parses", () => {
  const result = recipeSchema.safeParse(imageRecipe);
  assert.equal(result.success, true);
  assert.equal(result.data.image.rules.minWidth, 400);
});

test("a valid text recipe parses", () => {
  assert.equal(recipeSchema.safeParse(textRecipe).success, true);
});

test("a minimal recipe parses", () => {
  assert.equal(recipeSchema.safeParse({ name: "a", contentType: "text" }).success, true);
});

test("unknown contentType fails", () => {
  const r = recipeSchema.safeParse({ ...imageRecipe, contentType: "video" });
  assert.equal(r.success, false);
});

test("unknown text.mode fails", () => {
  const r = recipeSchema.safeParse({ ...textRecipe, text: { mode: "magic" } });
  assert.equal(r.success, false);
});

test("recipe requires a name", () => {
  assert.equal(recipeSchema.safeParse({ contentType: "image" }).success, false);
});

test("imageRulesSchema rejects non-numeric minWidth", () => {
  assert.equal(imageRulesSchema.safeParse({ minWidth: "big" }).success, false);
  assert.equal(imageRulesSchema.safeParse({ minWidth: 10, includeUrl: "a" }).success, true);
});

test("createProjectSchema requires name and recipe", () => {
  assert.equal(createProjectSchema.safeParse({ name: "p", recipe: imageRecipe }).success, true);
  assert.equal(createProjectSchema.safeParse({ name: "p" }).success, false);
});

test("updateProjectSchema accepts partial updates", () => {
  assert.equal(updateProjectSchema.safeParse({}).success, true);
  assert.equal(updateProjectSchema.safeParse({ name: "n" }).success, true);
  assert.equal(updateProjectSchema.safeParse({ recipe: imageRecipe }).success, true);
  assert.equal(updateProjectSchema.safeParse({ recipe: { name: "x" } }).success, false);
});

test("createRunSchema requires numeric projectId", () => {
  assert.equal(createRunSchema.safeParse({ projectId: 1, label: "l" }).success, true);
  assert.equal(createRunSchema.safeParse({ projectId: 1 }).success, true);
  assert.equal(createRunSchema.safeParse({ projectId: "1" }).success, false);
});

test("createRunSchema accepts valid overrides and rejects a wrong-typed one", () => {
  const ok = createRunSchema.safeParse({
    projectId: 1,
    overrides: { drive: true, driveFolder: "ID", driveSubfolder: "sub" },
  });
  assert.equal(ok.success, true);
  assert.deepEqual(ok.data.overrides, { drive: true, driveFolder: "ID", driveSubfolder: "sub" });
  assert.equal(createRunSchema.safeParse({ projectId: 1, overrides: {} }).success, true);
  assert.equal(createRunSchema.safeParse({ projectId: 1, overrides: { drive: "yes" } }).success, false);
  assert.equal(createRunSchema.safeParse({ projectId: 1, overrides: { driveFolder: 5 } }).success, false);
});

test("createRunSchema accepts a valid format override and rejects an unknown one", () => {
  for (const format of ["cbz", "pdf", "both", "loose"]) {
    assert.equal(
      createRunSchema.safeParse({ projectId: 1, overrides: { format } }).success,
      true,
      format,
    );
  }
  assert.equal(
    createRunSchema.safeParse({ projectId: 1, overrides: { format: "zip" } }).success,
    false,
  );
});

test("enqueueSchema accepts http(s) urls", () => {
  const r = enqueueSchema.safeParse({ urls: ["http://a.com/x", "https://b.com/y"] });
  assert.equal(r.success, true);
});

test("enqueueSchema rejects a non-http url", () => {
  assert.equal(enqueueSchema.safeParse({ urls: [] }).success, false);
  assert.equal(recipeSchema.safeParse({ name: "", contentType: "image" }).success, false);
  assert.equal(enqueueSchema.safeParse({ urls: ["ftp://a.com/x"] }).success, false);
  assert.equal(enqueueSchema.safeParse({ urls: ["javascript:alert(1)"] }).success, false);
  assert.equal(enqueueSchema.safeParse({ urls: ["not a url"] }).success, false);
});

test("previewSchema requires an http url and a recipe", () => {
  assert.equal(
    previewSchema.safeParse({ url: "https://a.com", recipe: imageRecipe }).success,
    true,
  );
  assert.equal(previewSchema.safeParse({ url: "file:///etc/passwd", recipe: imageRecipe }).success, false);
  assert.equal(previewSchema.safeParse({ url: "https://a.com" }).success, false);
});

test("parseOr400 returns {ok:true,data} for good input", () => {
  const r = parseOr400(enqueueSchema, { urls: ["https://a.com"] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.data, { urls: ["https://a.com"] });
});

test("parseOr400 returns a serializable {ok:false,error} for bad input", () => {
  const r = parseOr400(recipeSchema, { name: "a", contentType: "video" });
  assert.equal(r.ok, false);
  assert.ok(r.error);
  const roundTripped = JSON.parse(JSON.stringify(r.error));
  assert.deepEqual(roundTripped, r.error);
  assert.ok(roundTripped.issues.some((i) => i.path === "contentType"));
});

test("parseOr400 does not throw on garbage input", () => {
  assert.equal(parseOr400(recipeSchema, undefined).ok, false);
  assert.equal(parseOr400(recipeSchema, null).ok, false);
});
