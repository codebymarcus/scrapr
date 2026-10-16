import type { UseQueryResult } from "@tanstack/react-query";
import type { Project } from "@/lib/schemas";

// Select options for a project picker: a leading placeholder, then projects.
export function projectOptions(query: UseQueryResult<Project[]>) {
  const placeholder = query.isPending
    ? "Loading projects…"
    : "Select a project";
  return [
    { value: "", label: placeholder },
    ...(query.data ?? []).map((project) => ({
      value: String(project.id),
      label: project.name,
    })),
  ];
}
