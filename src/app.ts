import cors from "cors";
import express from "express";
import helmet from "helmet";
import { env } from "./config/env.js";
import { optionalAuth } from "./middleware/auth.js";
import { discoveryRouter } from "./routes/discovery.js";
import { feedRouter } from "./routes/feed.js";
import { fundraisingRouter } from "./routes/fundraising.js";
import { authRouter } from "./routes/auth.js";
import { socialRouter } from "./routes/social.js";
import { uploadsRouter } from "./routes/uploads.js";
import { messagesRouter } from "./routes/messages.js";
import { settingsRouter } from "./routes/settings.js";
import { notificationsRouter } from "./routes/notifications.js";

export const app = express();
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_ORIGIN, credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(optionalAuth);

app.get("/health", (_req, res) => res.json({ ok: true, service: "nerdding-backend", mode: env.DATABASE_URL ? "postgres" : "memory-preview" }));
app.use("/api/v1/feed", feedRouter);
app.use("/api/v1", discoveryRouter);
app.use("/api/v1/fundraisings", fundraisingRouter);
app.use("/api/v1/auth", authRouter);
app.use("/api/v1", socialRouter);
app.use("/api/v1/uploads", uploadsRouter);
app.use("/api/v1/messages", messagesRouter);
app.use("/api/v1/settings", settingsRouter);
app.use("/api/v1/notifications", notificationsRouter);

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error" });
});
