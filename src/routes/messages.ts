import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { conversations as dbConversations, conversationMembers, messages as dbMessages } from "../db/schema.js";

type Message = { id: string; conversationId: string; senderId: string; body: string; createdAt: string };
const conversations = new Map<string, { id: string; members: string[]; messages: Message[] }>();

export const messagesRouter = Router();

messagesRouter.get("/", requireAuth, (req, res) => res.json({ data: [...conversations.values()].filter((item) => item.members.includes(req.auth!.subjectId)).map(({ messages: _messages, ...item }) => ({ ...item, lastMessage: _messages.at(-1) ?? null })) }));

messagesRouter.post("/", requireAuth, async (req, res) => {
  const parsed = z.object({ recipientId: z.string().min(1), body: z.string().min(1).max(2000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Message cannot be empty." });
  if (db) {
    const conversationId = randomUUID();
      await db.insert(dbConversations).values({ id: conversationId });
      await db.insert(conversationMembers).values([{ conversationId, userId: req.auth!.subjectId }, { conversationId, userId: parsed.data.recipientId }]);
      const [created] = await db.insert(dbMessages).values({ conversationId, senderId: req.auth!.subjectId, body: parsed.data.body }).returning();
    return res.status(201).json({ data: created });
  }
  const conversation = [...conversations.values()].find((item) => item.members.includes(req.auth!.subjectId) && item.members.includes(parsed.data.recipientId));
  const item = conversation ?? { id: randomUUID(), members: [req.auth!.subjectId, parsed.data.recipientId], messages: [] };
  const message = { id: randomUUID(), conversationId: item.id, senderId: req.auth!.subjectId, body: parsed.data.body, createdAt: new Date().toISOString() };
  item.messages.push(message); conversations.set(item.id, item);
  return res.status(201).json({ data: message });
});

messagesRouter.get("/:conversationId", requireAuth, (req, res) => {
  const item = conversations.get(String(req.params.conversationId));
  if (!item || !item.members.includes(req.auth!.subjectId)) return res.status(404).json({ error: "Conversation not found." });
  return res.json({ data: item.messages });
});
