import type { Project } from "@/lib/schemas";

export function makeProject(
  overrides: Partial<Project> & { id: number },
): Project {
  return {
    name: `Project ${overrides.id}`,
    recipe: { name: `recipe-${overrides.id}`, contentType: "image" },
    created_at: "2026-10-16T08:00:00.000Z",
    updated_at: "2026-10-16T08:00:00.000Z",
    ...overrides,
  };
}
