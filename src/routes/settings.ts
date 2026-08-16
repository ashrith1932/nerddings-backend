import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { users, userSettings } from "../db/schema.js";
import { eq } from "drizzle-orm";

export const settingsRouter = Router();

settingsRouter.patch("/profile", requireAuth, async (req, res) => {
  const parsed = z.object({ name: z.string().min(2).max(160).optional(), bio: z.string().max(500).optional(), location: z.string().max(160).optional(), avatarUrl: z.string().url().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Profile details are invalid." });
  if (db) {
    const [updated] = await db.update(users).set(parsed.data).where(eq(users.id, req.auth!.subjectId)).returning({ id: users.id, name: users.name, bio: users.bio, location: users.location, avatarUrl: users.avatarUrl });
    return res.json({ data: updated });
  }
  return res.json({ data: { id: req.auth!.subjectId, ...parsed.data } });
});

settingsRouter.patch("/privacy", requireAuth, async (req, res) => {
  const parsed = z.object({ discoverable: z.boolean().optional(), emailNotifications: z.boolean().optional(), pushNotifications: z.boolean().optional(), allowMessages: z.boolean().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Privacy settings are invalid." });
  if (db) {
    const [updated] = await db.insert(userSettings).values({ userId: req.auth!.subjectId, ...parsed.data }).onConflictDoUpdate({ target: userSettings.userId, set: { ...parsed.data, updatedAt: new Date() } }).returning();
    return res.json({ data: updated });
  }
  return res.json({ data: { userId: req.auth!.subjectId, ...parsed.data } });
});
