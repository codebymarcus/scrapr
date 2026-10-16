// GET /api/ws?runId=<id> — streams hub events for a run as JSON text frames.
// @fastify/websocket v11 handler signature: (socket, req) with socket a `ws`
// WebSocket.
export async function wsRoutes(app, { hub }) {
  app.get("/api/ws", { websocket: true }, (socket, req) => {
    const { runId } = req.query ?? {};
    if (!runId) {
      socket.close(1008, "runId required");
      return;
    }
    const unsubscribe = hub.subscribe(String(runId), (event) => {
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
    });
    socket.on("close", unsubscribe);
    socket.on("error", unsubscribe);
  });
}
