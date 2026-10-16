import { createProjectSchema, parseOr400, updateProjectSchema } from "../schemas.mjs";

// Parse a route :id param as a positive integer; returns null when invalid.
function parseId(raw) {
  if (!/^[1-9]\d*$/.test(String(raw))) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}

function isForeignKeyError(err) {
  return (
    err?.code === "SQLITE_CONSTRAINT_FOREIGNKEY" ||
    /FOREIGN KEY constraint failed/i.test(err?.message ?? "")
  );
}

export async function projectRoutes(app, { store }) {
  function withId(handler) {
    return async (request, reply) => {
      const id = parseId(request.params.id);
      if (id === null) {
        return reply.code(400).send({ error: "Project id must be a positive integer" });
      }
      return handler(id, request, reply);
    };
  }

  app.post("/api/projects", async (request, reply) => {
    const parsed = parseOr400(createProjectSchema, request.body);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    return reply.code(201).send({ project: store.createProject(parsed.data) });
  });

  app.get("/api/projects", async () => ({ projects: store.listProjects() }));

  app.get(
    "/api/projects/:id",
    withId(async (id, request, reply) => {
      const project = store.getProject(id);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      return { project };
    }),
  );

  app.put(
    "/api/projects/:id",
    withId(async (id, request, reply) => {
      const parsed = parseOr400(updateProjectSchema, request.body);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
      const project = store.updateProject(id, parsed.data);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      return { project };
    }),
  );

  app.delete(
    "/api/projects/:id",
    withId(async (id, request, reply) => {
      if (!store.getProject(id)) return reply.code(404).send({ error: "Project not found" });
      try {
        store.deleteProject(id);
      } catch (err) {
        if (isForeignKeyError(err)) {
          return reply.code(409).send({
            error: "Project has runs and cannot be deleted. Delete its runs first.",
          });
        }
        throw err;
      }
      return reply.code(204).send();
    }),
  );
}
