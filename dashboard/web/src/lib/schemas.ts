import { z } from "zod";

// Zod mirrors of the dashboard backend shapes (dashboard/server/src/schemas.mjs
// and the db/store row shapes). Ids are SQLite integers.

export const imageRulesSchema = z.object({
  minWidth: z.number().optional(),
  minHeight: z.number().optional(),
  minBytes: z.number().optional(),
  includeSelector: z.string().optional(),
  excludeSelector: z.string().optional(),
  includeUrl: z.string().optional(),
  excludeUrl: z.string().optional(),
  position: z
    .object({
      from: z.number().optional(),
      to: z.number().optional(),
    })
    .optional(),
});

const textFieldSchema = z.object({
  name: z.string(),
  selector: z.string(),
  attr: z.string().optional(),
  many: z.boolean().optional(),
});

const textSchema = z.object({
  mode: z.enum(["article", "pattern", "selector"]),
  selector: z.string().optional(),
  fields: z.array(textFieldSchema).optional(),
  patterns: z.array(z.string()).optional(),
});

const pipelineStepSchema = z.object({
  mechanism: z.string(),
  maxAttempts: z.number().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

const imageSchema = z.object({
  pipeline: z.array(pipelineStepSchema).optional(),
  rules: imageRulesSchema.optional(),
  expectCount: z.number().optional(),
});

const outputSchema = z.object({
  cbz: z.boolean().optional(),
  pdf: z.boolean().optional(),
  keepLoose: z.boolean().optional(),
  quality: z.number().optional(),
  format: z.string().optional(),
  drive: z.boolean().optional(),
  driveFolder: z.string().optional(),
  driveSubfolder: z.string().optional(),
});

export const recipeSchema = z.object({
  name: z.string().min(1),
  contentType: z.enum(["image", "text"]),
  match: z.object({ hosts: z.array(z.string()).optional() }).optional(),
  text: textSchema.optional(),
  image: imageSchema.optional(),
  output: outputSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const projectSchema = z.object({
  id: z.number(),
  name: z.string(),
  recipe: recipeSchema,
  created_at: z.string().nullish(),
  updated_at: z.string().nullish(),
});

export const runStateSchema = z.enum([
  "queued",
  "running",
  "stopped",
  "done",
  "failed",
]);

export const runSchema = z.object({
  id: z.number(),
  project_id: z.number(),
  label: z.string().nullish(),
  state: runStateSchema,
  created_at: z.string().nullish(),
  started_at: z.string().nullish(),
  finished_at: z.string().nullish(),
});

export const itemSchema = z.object({
  id: z.number(),
  run_id: z.number(),
  url: z.string(),
  name: z.string().nullish(),
  status: z.string(),
  reason: z.string().nullish(),
  saved: z.number().nullish(),
  total: z.number().nullish(),
  // SQLite stores a 0/1 integer.
  needs_review: z.union([z.number(), z.boolean()]).nullish(),
  position: z.number().nullish(),
});

export const runDetailSchema = z.object({
  run: runSchema,
  items: z.array(itemSchema),
});

export const previewTextSchema = z.object({
  status: z.string(),
  via: z.string().optional(),
  mode: z.string().optional(),
  fields: z.unknown().optional(),
  // Set when `status` is "fail", so the UI can say why.
  code: z.string().optional(),
  message: z.string().optional(),
});

export const previewImageSchema = z.object({
  status: z.string(),
  via: z.string().optional(),
  images: z
    .array(
      z.object({
        url: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
        selector: z.string().optional(),
        index: z.number().optional(),
      }),
    )
    .optional(),
  unenforcedRuleKeys: z.array(z.string()).optional(),
  // Set when `status` is "fail", so the UI can say why.
  code: z.string().optional(),
  message: z.string().optional(),
});

export const driveStatusSchema = z.object({
  connected: z.boolean(),
  credentialsPath: z.string().optional(),
  tokenPath: z.string().optional(),
  hint: z.string().optional(),
});

// WebSocket run events. Engine log/progress events carry `ts` (epoch ms);
// the run manager's `item` / `state` events do not.
export const runEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("log"),
    level: z.string().optional(),
    message: z.string(),
    ts: z.number().optional(),
  }),
  z.object({
    type: z.literal("progress"),
    current: z.number(),
    total: z.number(),
    label: z.string().optional(),
    ts: z.number().optional(),
  }),
  z.object({
    type: z.literal("progress-end"),
    ts: z.number().optional(),
  }),
  z.object({
    type: z.literal("item"),
    id: z.number(),
    url: z.string().optional(),
    saved: z.number().nullish(),
    total: z.number().nullish(),
    ok: z.boolean().optional(),
    needsReview: z.boolean().optional(),
    ts: z.number().optional(),
  }),
  z.object({
    type: z.literal("state"),
    state: runStateSchema,
    ts: z.number().optional(),
  }),
]);

export type Recipe = z.infer<typeof recipeSchema>;
export type ImageRules = z.infer<typeof imageRulesSchema>;
export type Project = z.infer<typeof projectSchema>;
export type Run = z.infer<typeof runSchema>;
export type RunItem = z.infer<typeof itemSchema>;
export type RunDetail = z.infer<typeof runDetailSchema>;
export type TextPreview = z.infer<typeof previewTextSchema>;
export type ImagePreview = z.infer<typeof previewImageSchema>;
export type DriveStatus = z.infer<typeof driveStatusSchema>;
export type RunEvent = z.infer<typeof runEventSchema>;
