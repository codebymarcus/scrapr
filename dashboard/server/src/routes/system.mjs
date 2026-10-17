export async function systemRoutes(app) {
  app.get("/api/health", async () => ({ ok: true }));
}
