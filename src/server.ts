import { app } from "./app.js";
import { env } from "./config/env.js";
import { isDatabaseConfigured } from "./db/client.js";

if (env.NODE_ENV === "production" && !isDatabaseConfigured()) {
  throw new Error("DATABASE_URL is required in production. Configure Supabase/Postgres before starting Nerdding.");
}
if (env.NODE_ENV === "production" && env.AUTH_SECRET === "local-development-secret-change-me") {
  throw new Error("AUTH_SECRET must be changed before starting Nerdding in production.");
}

app.listen(env.PORT, () => {
  console.log(`Nerdding backend listening on http://localhost:${env.PORT}`);
});
