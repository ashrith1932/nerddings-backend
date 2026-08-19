import http from "node:http";
import { app } from "./app.js";
import { env } from "./config/env.js";
import { isDatabaseConfigured } from "./db/client.js";
import { ensureSocialSchema } from "./db/ensure-social-schema.js";
import { ensureEventsSchema } from "./db/ensure-events-schema.js";
import { ensureCheckmarkSchema } from "./db/ensure-checkmark-schema.js";
import { attachRealtimeServer } from "./realtime/socket.js";

if (env.NODE_ENV === "production" && !isDatabaseConfigured()) {
  throw new Error("DATABASE_URL is required in production. Configure Supabase/Postgres before starting Nerdding.");
}
if (env.NODE_ENV === "production" && env.AUTH_SECRET === "local-development-secret-change-me") {
  throw new Error("AUTH_SECRET must be changed before starting Nerdding in production.");
}

const server = http.createServer(app);
attachRealtimeServer(server);

await ensureSocialSchema();
await ensureEventsSchema();
await ensureCheckmarkSchema();

server.listen(env.PORT, () => {
  console.log(`Nerdding backend listening on http://localhost:${env.PORT}`);
  console.log(`Nerdding realtime listening on ws://localhost:${env.PORT}/api/v1/messages/ws`);
});
