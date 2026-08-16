import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { notifications, users } from "../db/schema.js";
import { desc, eq, isNull } from "drizzle-orm";

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [], unreadCount: 0 });
  const rows = await db.select({ notification: notifications, actor: users }).from(notifications).leftJoin(users, eq(notifications.actorId, users.id)).where(eq(notifications.recipientId, req.auth!.subjectId)).orderBy(desc(notifications.createdAt)).limit(50);
  return res.json({ data: rows.map(({ notification, actor }) => ({ id: notification.id, kind: notification.kind, entityId: notification.entityId, text: notification.text, readAt: notification.readAt?.toISOString() ?? null, createdAt: notification.createdAt.toISOString(), actor: actor ? { id: actor.id, name: actor.name, username: actor.username, accountType: actor.accountType, avatarUrl: actor.avatarUrl } : null })), unreadCount: rows.filter(({ notification }) => !notification.readAt).length });
});

notificationsRouter.post("/read-all", requireAuth, async (req, res) => {
  if (db) await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.recipientId, req.auth!.subjectId));
  return res.status(204).send();
});

notificationsRouter.post("/:notificationId/read", requireAuth, async (req, res) => {
  if (db) await db.update(notifications).set({ readAt: new Date() }).where(eq(notifications.id, String(req.params.notificationId)));
  return res.status(204).send();
});
