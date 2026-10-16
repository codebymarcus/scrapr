import { describe, expect, it } from "vitest";
import {
  driveStatusSchema,
  itemSchema,
  previewImageSchema,
  previewTextSchema,
  projectSchema,
  recipeSchema,
  runDetailSchema,
  runEventSchema,
  runSchema,
} from "./schemas";

const validRecipe = {
  name: "demo",
  contentType: "image",
  match: { hosts: ["example.com"] },
  image: {
    pipeline: [{ mechanism: "dom", maxAttempts: 2 }],
    rules: { minWidth: 100, position: { from: 1, to: 5 } },
    expectCount: 10,
  },
  output: { cbz: true, quality: 80, format: "webp" },
};

describe("recipeSchema", () => {
  it("accepts a valid image recipe", () => {
    expect(recipeSchema.safeParse(validRecipe).success).toBe(true);
  });

  it("accepts a valid text recipe", () => {
    const result = recipeSchema.safeParse({
      name: "t",
      contentType: "text",
      text: {
        mode: "pattern",
        fields: [{ name: "title", selector: "h1", many: false }],
        patterns: ["a"],
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a bad contentType enum", () => {
    expect(
      recipeSchema.safeParse({ ...validRecipe, contentType: "video" }).success,
    ).toBe(false);
  });

  it("rejects a bad text mode enum", () => {
    expect(
      recipeSchema.safeParse({
        name: "t",
        contentType: "text",
        text: { mode: "bogus" },
      }).success,
    ).toBe(false);
  });
});

describe("projectSchema", () => {
  it("accepts a project wrapping a recipe", () => {
    const result = projectSchema.safeParse({
      id: 1,
      name: "Proj",
      recipe: validRecipe,
      created_at: "2026-01-01",
    });
    expect(result.success).toBe(true);
  });
});

describe("runSchema", () => {
  it("accepts a valid run", () => {
    expect(
      runSchema.safeParse({ id: 1, project_id: 1, state: "running" })
        .success,
    ).toBe(true);
  });

  it("rejects a bad state enum", () => {
    expect(
      runSchema.safeParse({ id: 1, project_id: 1, state: "paused" })
        .success,
    ).toBe(false);
  });
});

describe("itemSchema / runDetailSchema", () => {
  const item = { id: 1, run_id: 1, url: "https://x/1", status: "done", needs_review: 0 };

  it("accepts an item", () => {
    expect(itemSchema.safeParse(item).success).toBe(true);
  });

  it("accepts a run detail", () => {
    const result = runDetailSchema.safeParse({
      run: { id: 1, project_id: 1, state: "done" },
      items: [item],
    });
    expect(result.success).toBe(true);
  });
});

describe("preview + drive schemas", () => {
  it("accepts a text preview", () => {
    expect(
      previewTextSchema.safeParse({ status: "ok", mode: "article" }).success,
    ).toBe(true);
  });

  it("accepts an image preview", () => {
    expect(
      previewImageSchema.safeParse({
        status: "ok",
        images: [{ url: "https://x/a.jpg", width: 10 }],
        unenforcedRuleKeys: ["minBytes"],
      }).success,
    ).toBe(true);
  });

  it("accepts a drive status", () => {
    expect(driveStatusSchema.safeParse({ connected: false }).success).toBe(
      true,
    );
  });
});

describe("runEventSchema", () => {
  const ts = 1700000000000;

  it.each([
    { type: "log", level: "info", message: "hello", ts },
    { type: "progress", current: 1, total: 10, label: "page", ts },
    { type: "progress-end", ts },
    {
      type: "item",
      id: 1,
      url: "https://x/1",
      saved: 3,
      total: 4,
      ok: true,
      needsReview: false,
    },
    { type: "state", state: "done" },
  ])("parses a $type event", (event) => {
    const result = runEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("rejects an unknown event type", () => {
    expect(runEventSchema.safeParse({ type: "nope", ts }).success).toBe(false);
  });

  it("rejects a bad state value", () => {
    expect(
      runEventSchema.safeParse({ type: "state", ts, state: "weird" }).success,
    ).toBe(false);
  });
});
