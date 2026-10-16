import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import { createHub } from "./hub.mjs";
import { previewRoutes } from "./routes/preview.mjs";
import { projectRoutes } from "./routes/projects.mjs";
import { runRoutes } from "./routes/runs.mjs";
import { systemRoutes } from "./routes/system.mjs";
import { wsRoutes } from "./routes/ws.mjs";

// deps: { store, runManager, browserFactory, fetch, driveStatus, hub } — all
// injectable so tests pass fakes. Unset deps default lazily to real
// implementations in the routes/modules that need them.
export function buildApp(deps = {}) {
  const app = Fastify({ logger: false });
  app.decorate("deps", deps);
  // Live-event hub: exposed as `app.hub` so the server can wire `hub.emit` as
  // the run manager's `emit`.
  const hub = deps.hub ?? createHub();
  app.decorate("hub", hub);
  app.register(fastifyWebsocket);
  app.register(wsRoutes, { hub });
  app.register(systemRoutes, { driveStatus: deps.driveStatus });
  app.register(previewRoutes, {
    getBrowser: deps.getBrowser,
    previewText: deps.previewText,
    imagePreview: deps.imagePreview,
    fetch: deps.fetch,
    thumbMaxBytes: deps.thumbMaxBytes,
    thumbTimeoutMs: deps.thumbTimeoutMs,
  });
  if (deps.store) {
    app.register(projectRoutes, { store: deps.store });
    app.register(runRoutes, {
      store: deps.store,
      runManager: deps.runManager,
      runOutDir: deps.runOutDir,
    });
  }
  return app;
}
