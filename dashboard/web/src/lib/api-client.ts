import { API_BASE } from "./api-base";
import { createApiClient } from "./http/api-client";

export const dashboardClient = createApiClient({ baseUrl: API_BASE });
