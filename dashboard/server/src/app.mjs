import Fastify from "fastify";
import fastifyMultipart from "@fastify/multipart";
import fastifyWebsocket from "@fastify/websocket";
import { createHub } from "./hub.mjs";
import { driveRoutes } from "./routes/drive.mjs";
import { previewRoutes } from "./routes/preview.mjs";
import { projectRoutes } from "./routes/projects.mjs";
import { runRoutes } from "./routes/runs.mjs";
import { systemRoutes } from "./routes/system.mjs";
import { wsRoutes } from "./routes/ws.mjs";

// deps: { store, runManager, browserFactory, fetch, driveAuth, hub } — all
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
  // Spreadsheet uploads for run import (one file, size-capped).
  app.register(fastifyMultipart, {
    // On limit, truncate the stream (so toBuffer resolves and file.truncated is
    // true → the route returns 413) rather than throwing a 500.
    throwFileSizeLimit: false,
    limits: { files: 1, fileSize: deps.uploadMaxBytes ?? 5_000_000 },
  });
  app.register(wsRoutes, { hub });
  app.register(systemRoutes);
  app.register(driveRoutes, { driveAuth: deps.driveAuth });
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
