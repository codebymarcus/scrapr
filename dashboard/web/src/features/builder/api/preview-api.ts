import type { ApiClient } from "@/lib/http/api-client";
import { dashboardClient } from "@/lib/api-client";
import { previewImageSchema, previewTextSchema } from "@/lib/schemas";
import type { ImagePreview, TextPreview } from "@/lib/schemas";
import type { PreviewInput } from "../types";

export function previewImage(
  input: PreviewInput,
  client: ApiClient = dashboardClient,
): Promise<ImagePreview> {
  return client.post("/api/preview/image", {
    body: input,
    schema: previewImageSchema,
  });
}

export function previewText(
  input: PreviewInput,
  client: ApiClient = dashboardClient,
): Promise<TextPreview> {
  return client.post("/api/preview/text", {
    body: input,
    schema: previewTextSchema,
  });
}
