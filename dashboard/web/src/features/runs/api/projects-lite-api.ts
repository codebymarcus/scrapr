import { z } from "zod";
import type { ApiClient } from "@/lib/http/api-client";
import { dashboardClient } from "@/lib/api-client";
import { projectSchema } from "@/lib/schemas";
import type { Project } from "@/lib/schemas";

// STOPGAP: a minimal project list so the run dialogs can pick a project.
// The projects feature (Task 8) owns the full API and should replace this.
const projectsEnvelopeSchema = z.object({ projects: z.array(projectSchema) });

export async function fetchProjects(
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<Project[]> {
  const { projects } = await client.get("/api/projects", {
    schema: projectsEnvelopeSchema,
    signal,
  });
  return projects;
}
