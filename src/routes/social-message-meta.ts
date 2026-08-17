import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const socialMessageMetaRouter = Router();

socialMessageMetaRouter.get("/messages/unread-count", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: { unreadCount: 0, pendingRequests: 0 } });
  const rows = await db.execute(sql`SELECT COUNT(*)::int AS unread_count FROM messages m JOIN conversation_members cm ON cm.conversation_id=m.conversation_id WHERE cm.user_id=${req.auth!.subjectId} AND m.sender_id<>${req.auth!.subjectId} AND m.read_at IS NULL`) as unknown as Array<{ unread_count: number }>;
  const requests = await db.execute(sql`SELECT COUNT(*)::int AS pending_requests FROM message_requests WHERE recipient_id=${req.auth!.subjectId} AND status='pending'`) as unknown as Array<{ pending_requests: number }>;
  res.json({ data: { unreadCount: Number(rows[0]?.unread_count ?? 0), pendingRequests: Number(requests[0]?.pending_requests ?? 0) } });
});
