import type { Recipe } from "@/lib/schemas";

/** Body of `POST /api/projects`. */
export type ProjectInput = {
  name: string;
  recipe: Recipe;
};

/** Body of `PUT /api/projects/:id`: any subset of the create fields. */
export type ProjectUpdate = Partial<ProjectInput>;

/**
 * Router state `ProjectsPage` passes to the runs page ("/") so it opens the
 * new-run dialog with this project preselected.
 */
export type NewRunFromProjectState = { newRunProjectId: number };

/**
 * A delete the server refused because the project still has runs (409) is an
 * expected outcome: data to show inline, not a throw.
 */
export type DeleteProjectResult = { ok: true } | { ok: false; error: string };
