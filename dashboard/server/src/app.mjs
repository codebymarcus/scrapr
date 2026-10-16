import Fastify from "fastify";
import { systemRoutes } from "./routes/system.mjs";

// deps: { store, runManager, browserFactory, fetch, driveStatus } — all
// injectable so tests pass fakes. Unset deps default lazily to real
// implementations in the routes/modules that need them.
export function buildApp(deps = {}) {
  const app = Fastify({ logger: false });
  app.decorate("deps", deps);
  app.register(systemRoutes, { driveStatus: deps.driveStatus });
  return app;
}
