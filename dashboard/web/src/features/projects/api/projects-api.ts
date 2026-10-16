import { z } from "zod";
import type { ApiClient } from "@/lib/http/api-client";
import { dashboardClient } from "@/lib/api-client";
import { projectSchema } from "@/lib/schemas";
import type { Project } from "@/lib/schemas";
import type { ProjectInput, ProjectUpdate } from "../types";

const projectsEnvelopeSchema = z.object({ projects: z.array(projectSchema) });
const projectEnvelopeSchema = z.object({ project: projectSchema });

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

export async function fetchProject(
  id: number,
  signal?: AbortSignal,
  client: ApiClient = dashboardClient,
): Promise<Project> {
  const { project } = await client.get(`/api/projects/${id}`, {
    schema: projectEnvelopeSchema,
    signal,
  });
  return project;
}

export async function createProject(
  input: ProjectInput,
  client: ApiClient = dashboardClient,
): Promise<Project> {
  const { project } = await client.post("/api/projects", {
    body: input,
    schema: projectEnvelopeSchema,
  });
  return project;
}

export async function updateProject(
  id: number,
  changes: ProjectUpdate,
  client: ApiClient = dashboardClient,
): Promise<Project> {
  const { project } = await client.put(`/api/projects/${id}`, {
    body: changes,
    schema: projectEnvelopeSchema,
  });
  return project;
}

export function deleteProject(
  id: number,
  client: ApiClient = dashboardClient,
): Promise<void> {
  return client.del(`/api/projects/${id}`);
}
