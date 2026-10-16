import { useMutation } from "@tanstack/react-query";
import { dashboardClient } from "@/lib/api-client";
import type { ApiClient } from "@/lib/http/api-client";
import { previewImage, previewText } from "../api/preview-api";
import type { PreviewInput } from "../types";

// Previews are a user-triggered action (they drive a real browser), so they
// are mutations rather than queries: no caching, no refetch on focus.

export function usePreviewImage(client: ApiClient = dashboardClient) {
  return useMutation({
    mutationFn: (input: PreviewInput) => previewImage(input, client),
  });
}

export function usePreviewText(client: ApiClient = dashboardClient) {
  return useMutation({
    mutationFn: (input: PreviewInput) => previewText(input, client),
  });
}
