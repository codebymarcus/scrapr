/**
 * Query-key factory for the `projects` feature. Build keys through these
 * helpers, never inline. `all` is the shared invalidation prefix.
 */
export const projectKeys = {
  all: ["projects"] as const,
  lists: () => [...projectKeys.all, "list"] as const,
  detail: (id: number) => [...projectKeys.all, "detail", id] as const,
};
