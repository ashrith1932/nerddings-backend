import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";

export const notificationsRouter = Router();
notificationsRouter.get("/", requireAuth, (_req, res) => res.json({ data: [] }));
notificationsRouter.post("/read-all", requireAuth, (_req, res) => res.status(204).send());
