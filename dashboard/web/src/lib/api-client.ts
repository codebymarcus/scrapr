import { createApiClient } from "./http/api-client";

export const dashboardClient = createApiClient({
  baseUrl: import.meta.env.VITE_API_BASE ?? "http://localhost:5174",
});
