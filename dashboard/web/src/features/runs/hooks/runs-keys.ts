/**
 * Query-key factory for the `runs` feature. Build keys through these helpers,
 * never inline. `all` is the shared invalidation prefix.
 */
export const runKeys = {
  all: ["runs"] as const,
  lists: () => [...runKeys.all, "list"] as const,
  detail: (id: number) => [...runKeys.all, "detail", id] as const,
};
