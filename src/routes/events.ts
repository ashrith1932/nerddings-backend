import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { eventRsvps, events, users } from "../db/schema.js";
import { and, desc, eq } from "drizzle-orm";

type MemoryEvent = { id: string; creatorId: string; title: string; description: string; eventType: string; startsAt: string; location: string; url?: string; rsvpCount: number };
const memoryEvents: MemoryEvent[] = [];

export const eventsRouter = Router();

eventsRouter.get("/", async (_req, res) => {
  const database = db;
  if (!database) return res.json({ data: memoryEvents });
  const rows = await database.select({ event: events, creator: users }).from(events).innerJoin(users, eq(events.creatorId, users.id)).orderBy(desc(events.startsAt)).limit(50);
  const result = await Promise.all(rows.map(async ({ event, creator }) => {
    const rsvps = await database.select().from(eventRsvps).where(eq(eventRsvps.eventId, event.id));
    return { id: event.id, creatorId: event.creatorId, creator: { id: creator.id, name: creator.name, username: creator.username, avatarUrl: creator.avatarUrl }, title: event.title, description: event.description, eventType: event.eventType, startsAt: event.startsAt.toISOString(), location: event.location, url: event.url, rsvpCount: rsvps.length };
  }));
  return res.json({ data: result });
});

eventsRouter.post("/", requireAuth, async (req, res) => {
  const parsed = z.object({ title: z.string().min(2).max(180), description: z.string().min(2).max(2000), eventType: z.string().min(2).max(40).default("Community"), startsAt: z.string().datetime(), location: z.string().min(2).max(180), url: z.string().url().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter valid event details." });
  if (db) {
    const [created] = await db.insert(events).values({ creatorId: req.auth!.subjectId, ...parsed.data, startsAt: new Date(parsed.data.startsAt) }).returning();
    return res.status(201).json({ data: created });
  }
  const created = { id: randomUUID(), creatorId: req.auth!.subjectId, ...parsed.data, rsvpCount: 0 };
  memoryEvents.unshift(created);
  return res.status(201).json({ data: created });
});

eventsRouter.post("/:eventId/rsvp", requireAuth, async (req, res) => {
  const eventId = String(req.params.eventId);
  const parsed = z.object({ status: z.enum(["interested", "going"]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a valid RSVP status." });
  if (db) {
    const [existing] = await db.select().from(eventRsvps).where(and(eq(eventRsvps.eventId, eventId), eq(eventRsvps.userId, req.auth!.subjectId))).limit(1);
    if (existing) await db.update(eventRsvps).set({ status: parsed.data.status }).where(and(eq(eventRsvps.eventId, eventId), eq(eventRsvps.userId, req.auth!.subjectId)));
    else await db.insert(eventRsvps).values({ eventId, userId: req.auth!.subjectId, status: parsed.data.status });
    return res.json({ data: { eventId, status: parsed.data.status, active: true } });
  }
  const event = memoryEvents.find((item) => item.id === eventId);
  if (!event) return res.status(404).json({ error: "Event not found." });
  event.rsvpCount += 1;
  return res.json({ data: { eventId, status: parsed.data.status, active: true } });
});
