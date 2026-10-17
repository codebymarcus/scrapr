// Zod domain schemas for the dashboard API. They mirror the engine recipe shape
// (src/recipes/recipe.mjs) and ImageRules (src/recipes/image-filter.mjs).
import { z } from "zod";

// http(s) URL only: blocks file:, javascript:, ftp:, etc.
const httpUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//i.test(value), { message: "URL must use http or https" });

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
  // A built-in recipe is driven by the engine's own URL-matched profile, not by this recipe's data.
  builtIn: z.boolean().optional(),
  builtInProfile: z.string().optional(),
});

export const createProjectSchema = z.object({
  name: z.string().min(1),
  recipe: recipeSchema,
});

export const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  recipe: recipeSchema.optional(),
});

export const createRunSchema = z.object({
  projectId: z.number(),
  label: z.string().optional(),
  // Per-run Drive overrides, merged into the engine config at execution time (never the recipe).
  overrides: z
    .object({
      drive: z.boolean().optional(),
      driveFolder: z.string().optional(),
      driveSubfolder: z.string().optional(),
    })
    .optional(),
});

export const enqueueSchema = z.object({
  urls: z.array(httpUrl).min(1),
});

export const previewSchema = z.object({
  url: httpUrl,
  recipe: recipeSchema,
});

// Validate `data` against `schema` without throwing. On failure `error` is a
// plain JSON-serializable object: { formErrors, fieldErrors, issues[] } where
// each issue is { path: "a.b.0", message }.
export function parseOr400(schema, data) {
  const result = schema.safeParse(data);
  if (result.success) return { ok: true, data: result.data };
  const flat = z.flattenError(result.error);
  return {
    ok: false,
    error: {
      formErrors: flat.formErrors,
      fieldErrors: flat.fieldErrors,
      issues: result.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    },
  };
}
