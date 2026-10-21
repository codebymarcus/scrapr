import { describe, expect, it } from "vitest";
import {
  driveAccountsSchema,
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

  it("keeps the output/upload fields and treats them as optional", () => {
    const parsed = itemSchema.parse({
      ...item,
      output_name: "Ch 1.cbz",
      uploaded_at: "2026-10-18T00:00:00Z",
      drive_link: "https://drive.example/f/1",
    });
    expect(parsed.output_name).toBe("Ch 1.cbz");
    expect(parsed.uploaded_at).toBe("2026-10-18T00:00:00Z");
    expect(parsed.drive_link).toBe("https://drive.example/f/1");
    expect(
      itemSchema.safeParse({
        ...item,
        output_name: null,
        uploaded_at: null,
        drive_link: null,
      }).success,
    ).toBe(true);
  });

  it("accepts a run detail", () => {
    const result = runDetailSchema.safeParse({
      run: { id: 1, project_id: 1, state: "done" },
      items: [item],
      summary: {
        durationMs: null,
        counts: { total: 1, completed: 1, failed: 0, skipped: 0, uploaded: 0 },
        pages: 3,
        uploadedSize: 0,
        bytesDownloaded: 100,
        cost: 0,
      },
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

  it("accepts a captured thumbnail and the built-in recipe name", () => {
    const thumbnail = "data:image/webp;base64,AAAA";
    const parsed = previewImageSchema.parse({
      status: "ok",
      images: [{ url: "https://x/a.jpg", thumbnail }],
      builtInRecipe: "batcave",
    });
    expect(parsed.images?.[0]?.thumbnail).toBe(thumbnail);
    expect(parsed.builtInRecipe).toBe("batcave");
  });

  it("accepts a null built-in recipe", () => {
    expect(
      previewImageSchema.safeParse({ status: "ok", builtInRecipe: null }).success,
    ).toBe(true);
  });

  it("keeps the code and message of a failed preview", () => {
    const failed = { status: "fail", code: "HTTP_ERROR", message: "403" };
    expect(previewImageSchema.parse(failed)).toMatchObject(failed);
    expect(previewTextSchema.parse(failed)).toMatchObject(failed);
  });

  it("accepts a drive status", () => {
    expect(
      driveStatusSchema.safeParse({
        connected: false,
        configured: true,
        reason: "needs-reconnect",
        hint: "Reconnect Drive.",
      }).success,
    ).toBe(true);
    expect(driveStatusSchema.safeParse({ connected: false }).success).toBe(
      false,
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
    {
      type: "item",
      id: 1,
      outputName: "Ch 1.cbz",
      uploaded: true,
      driveLink: "https://drive.example/f/1",
    },
    { type: "state", state: "done" },
  ])("parses a $type event", (event) => {
    const result = runEventSchema.safeParse(event);
    expect(result.success).toBe(true);
  });

  it("keeps the output/upload fields on an item event", () => {
    const parsed = runEventSchema.parse({
      type: "item",
      id: 1,
      outputName: "Ch 1.cbz",
      uploaded: true,
      driveLink: "https://drive.example/f/1",
    });
    expect(parsed).toMatchObject({
      outputName: "Ch 1.cbz",
      uploaded: true,
      driveLink: "https://drive.example/f/1",
    });
  });

  it("parses a progress event with an itemId", () => {
    const e = runEventSchema.parse({
      type: "progress",
      itemId: 7,
      current: 2,
      total: 5,
    });
    expect(e).toMatchObject({ type: "progress", itemId: 7, current: 2, total: 5 });
  });

  it("parses a progress-end event with an itemId", () => {
    const e = runEventSchema.parse({ type: "progress-end", itemId: 7, ts });
    expect(e).toMatchObject({ type: "progress-end", itemId: 7 });
  });

  it("still parses progress events without an itemId", () => {
    const e = runEventSchema.parse({ type: "progress", current: 1, total: 2 });
    expect(e).not.toHaveProperty("itemId");
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

describe("driveAccountsSchema", () => {
  it("parses the accounts list", () => {
    const parsed = driveAccountsSchema.parse({
      configured: true,
      accounts: [
        { id: "a1", label: "Work", email: "w@example.com", connected: true },
      ],
    });
    expect(parsed.accounts[0]).toEqual({
      id: "a1",
      label: "Work",
      email: "w@example.com",
      connected: true,
    });
  });

  it("accepts null label and email (migrated account)", () => {
    const result = driveAccountsSchema.safeParse({
      configured: false,
      accounts: [{ id: "a1", label: null, email: null, connected: false }],
    });
    expect(result.success).toBe(true);
  });

  it("rejects an account without an id", () => {
    const result = driveAccountsSchema.safeParse({
      configured: true,
      accounts: [{ label: null, email: null, connected: true }],
    });
    expect(result.success).toBe(false);
  });
});
