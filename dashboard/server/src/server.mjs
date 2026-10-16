import { buildApp } from "./app.mjs";
import { PORT } from "./config.mjs";

const app = buildApp();
try {
  await app.listen({ port: PORT, host: "127.0.0.1" });
  console.log(`dashboard server listening on http://127.0.0.1:${PORT}`);
} catch (err) {
  console.error(err);
  process.exit(1);
}
