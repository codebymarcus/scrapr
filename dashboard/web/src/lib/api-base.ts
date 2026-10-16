/** Dashboard server origin: `VITE_API_BASE`, else the local dev server. */
export const API_BASE: string =
  import.meta.env.VITE_API_BASE ?? "http://localhost:5174";
