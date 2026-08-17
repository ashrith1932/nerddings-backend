import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireAgent, requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

type Row = Record<string, any>;
const memoryEvents: Row[] = [];

export const eventsRouter = Router();

function resultRows<T extends Row>(value: unknown): T[] {
  const result = value as T[] | { rows?: T[] };
  return Array.isArray(result) ? result : result.rows ?? [];
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 180) || "event";
}

function normalizeTopics(values: unknown) {
  const list = Array.isArray(values) ? values : [];
  return [...new Set(list.map(value => String(value).trim()).filter(Boolean).slice(0, 8))];
}

async function syncTopics(eventId: string, topics: string[]) {
  if (!db) return;
  await db.execute(sql`DELETE FROM event_topic_map WHERE event_id=${eventId}`);
  for (const name of topics) {
    const slug = slugify(name).slice(0, 120);
    const topicRows = await db.execute(sql`
      INSERT INTO event_topics(name,slug)
      VALUES(${name},${slug})
      ON CONFLICT(name) DO UPDATE SET name=EXCLUDED.name
      RETURNING id
    `);
    const topic = resultRows<{ id: string }>(topicRows)[0];
    if (topic) await db.execute(sql`INSERT INTO event_topic_map(event_id,topic_id) VALUES(${eventId},${topic.id}) ON CONFLICT DO NOTHING`);
  }
}

async function serializeEvent(eventId: string, viewerId?: string) {
  if (!db) return memoryEvents.find(item => item.id === eventId) ?? null;
  const result = await db.execute(sql`
    SELECT e.id,e.creator_id,e.title,e.slug,e.description,e.short_description,e.cover_image_url,
      e.event_type,e.format,e.location,e.location_address,e.city,e.country,e.online_url,
      e.starts_at,e.end_at,e.timezone,e.max_attendees,e.status,e.created_at,e.updated_at,e.published_at,e.cancelled_at,
      u.id host_id,u.name host_name,u.username host_username,u.avatar_url host_avatar,
      (SELECT COUNT(*)::int FROM event_rsvps er WHERE er.event_id=e.id AND er.status='going') rsvp_count,
      ${viewerId ? sql`EXISTS(SELECT 1 FROM event_rsvps evr WHERE evr.event_id=e.id AND evr.user_id=${viewerId} AND evr.status='going')` : sql`false`} viewer_going,
      ${viewerId ? sql`EXISTS(SELECT 1 FROM event_bookmarks eb WHERE eb.event_id=e.id AND eb.user_id=${viewerId})` : sql`false`} viewer_saved,
      COALESCE((SELECT json_agg(et.name ORDER BY et.name) FROM event_topic_map etm JOIN event_topics et ON et.id=etm.topic_id WHERE etm.event_id=e.id),'[]'::json) topics
    FROM events e JOIN users u ON u.id=e.creator_id
    WHERE e.id=${eventId}
    LIMIT 1
  `);
  const row = resultRows<Row>(result)[0];
  if (!row) return null;
  return {
    id: row.id, creatorId: row.creator_id, title: row.title, slug: row.slug, description: row.description,
    shortDescription: row.short_description, coverImageUrl: row.cover_image_url, eventType: row.event_type,
    format: row.format, location: row.location, locationAddress: row.location_address, city: row.city,
    country: row.country, onlineUrl: row.online_url, startsAt: row.starts_at, endsAt: row.end_at,
    timezone: row.timezone, maxAttendees: row.max_attendees, status: row.status, createdAt: row.created_at,
    updatedAt: row.updated_at, publishedAt: row.published_at, cancelledAt: row.cancelled_at,
    creator: { id: row.host_id, name: row.host_name, username: row.host_username, avatarUrl: row.host_avatar },
    rsvpCount: Number(row.rsvp_count ?? 0), viewerGoing: Boolean(row.viewer_going), viewerSaved: Boolean(row.viewer_saved),
    topics: Array.isArray(row.topics) ? row.topics : [],
  };
}

const eventInputBase = z.object({
  title: z.string().trim().min(2).max(180),
  shortDescription: z.string().trim().max(500).optional().default(""),
  description: z.string().trim().min(2).max(5000),
  coverImageUrl: z.string().url().nullable().optional(),
  eventType: z.string().trim().min(2).max(40),
  format: z.enum(["in_person", "online", "hybrid"]),
  location: z.string().trim().max(180).optional().default(""),
  locationAddress: z.string().trim().max(500).optional().default(""),
  city: z.string().trim().max(100).optional().default(""),
  country: z.string().trim().max(100).optional().default(""),
  onlineUrl: z.string().url().nullable().optional(),
  startsAt: z.string().datetime(),
  endsAt: z.string().datetime(),
  timezone: z.string().trim().min(1).max(100),
  maxAttendees: z.number().int().positive().nullable().optional(),
  topics: z.array(z.string().trim().min(1).max(100)).max(8).optional().default([]),
  status: z.enum(["draft", "published"]).optional().default("published"),
});

const eventInput = eventInputBase.superRefine((value, ctx) => {
  if (new Date(value.endsAt).getTime() <= new Date(value.startsAt).getTime()) ctx.addIssue({ code: "custom", path: ["endsAt"], message: "End time must be after start time." });
  if ((value.format === "online" || value.format === "hybrid") && !value.onlineUrl) ctx.addIssue({ code: "custom", path: ["onlineUrl"], message: "Online URL is required for online or hybrid events." });
  if ((value.format === "in_person" || value.format === "hybrid") && !value.location.trim()) ctx.addIssue({ code: "custom", path: ["location"], message: "Location is required for in-person or hybrid events." });
});

async function publicEvents(req: any, res: any) {
  if (!db) return res.json({ data: memoryEvents.filter(item => item.status === "published") });
  const limit = Math.min(Number(req.query.limit) || 30, 50);
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const eventType = typeof req.query.eventType === "string" && req.query.eventType !== "all" ? req.query.eventType : "";
  const format = typeof req.query.format === "string" && req.query.format !== "all" ? req.query.format : "";
  const location = typeof req.query.location === "string" && req.query.location !== "all" ? req.query.location : "";
  const past = String(req.query.past ?? "false") === "true";
  const nowFilter = past ? sql`e.end_at < NOW()` : sql`e.end_at >= NOW()`;
  const query = q ? `%${q}%` : null;
  const result = await db.execute(sql`
    SELECT e.id,e.creator_id,e.title,e.slug,e.description,e.short_description,e.cover_image_url,e.event_type,e.format,
      e.location,e.city,e.country,e.online_url,e.starts_at,e.end_at,e.timezone,e.max_attendees,e.status,e.created_at,
      u.id host_id,u.name host_name,u.username host_username,u.avatar_url host_avatar,
      (SELECT COUNT(*)::int FROM event_rsvps er WHERE er.event_id=e.id AND er.status='going') rsvp_count,
      COALESCE((SELECT json_agg(et.name ORDER BY et.name) FROM event_topic_map etm JOIN event_topics et ON et.id=etm.topic_id WHERE etm.event_id=e.id),'[]'::json) topics
    FROM events e JOIN users u ON u.id=e.creator_id
    WHERE e.status IN ('published','completed')
      AND e.status <> 'cancelled'
      AND ${nowFilter}
      ${eventType ? sql`AND e.event_type=${eventType}` : sql``}
      ${format ? sql`AND e.format=${format}` : sql``}
      ${location ? sql`AND (e.location ILIKE ${`%${location}%`} OR e.city ILIKE ${`%${location}%`} OR e.country ILIKE ${`%${location}%`})` : sql``}
      ${query ? sql`AND (e.title ILIKE ${query} OR e.description ILIKE ${query} OR e.short_description ILIKE ${query} OR e.location ILIKE ${query} OR e.city ILIKE ${query} OR EXISTS(SELECT 1 FROM event_topic_map sqm JOIN event_topics sqt ON sqt.id=sqm.topic_id WHERE sqm.event_id=e.id AND sqt.name ILIKE ${query}))` : sql``}
    ORDER BY e.starts_at ${past ? sql`DESC` : sql`ASC`}
    LIMIT ${limit}
  `);
  const data = resultRows<Row>(result).map(row => ({
    id: row.id, creatorId: row.creator_id, title: row.title, slug: row.slug, description: row.description,
    shortDescription: row.short_description, coverImageUrl: row.cover_image_url, eventType: row.event_type,
    format: row.format, location: row.location, city: row.city, country: row.country, onlineUrl: row.online_url,
    startsAt: row.starts_at, endsAt: row.end_at, timezone: row.timezone, maxAttendees: row.max_attendees,
    status: row.status, creator: { id: row.host_id, name: row.host_name, username: row.host_username, avatarUrl: row.host_avatar },
    rsvpCount: Number(row.rsvp_count ?? 0), topics: Array.isArray(row.topics) ? row.topics : [],
  }));
  return res.json({ data });
}

eventsRouter.get("/", publicEvents);
eventsRouter.get("/recommended", publicEvents);

eventsRouter.get("/agent/events", requireAgent, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const result = await db.execute(sql`
    SELECT e.id,e.title,e.slug,e.description,e.short_description,e.cover_image_url,e.event_type,e.format,e.location,e.city,e.starts_at,e.end_at,e.timezone,e.max_attendees,e.status,e.created_at,e.updated_at,
      (SELECT COUNT(*)::int FROM event_rsvps er WHERE er.event_id=e.id AND er.status='going') rsvp_count
    FROM events e WHERE e.creator_id=${req.auth!.subjectId}
    ORDER BY e.starts_at DESC
  `);
  return res.json({ data: resultRows(result) });
});

eventsRouter.get("/agent/events/drafts", requireAgent, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const result = await db.execute(sql`SELECT id,title,slug,description,short_description,event_type,format,location,city,starts_at,end_at,timezone,max_attendees,status,created_at,updated_at FROM events WHERE creator_id=${req.auth!.subjectId} AND status='draft' ORDER BY updated_at DESC`);
  return res.json({ data: resultRows(result) });
});

eventsRouter.post("/", requireAgent, async (req, res) => {
  const parsed = eventInput.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Enter valid event details." });
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const value = parsed.data;
  const id = randomUUID();
  const slug = `${slugify(value.title)}-${id.slice(0, 8)}`;
  const status = value.status === "draft" ? "draft" : "published";
  const created = await db.execute(sql`
    INSERT INTO events(id,creator_id,title,slug,description,short_description,cover_image_url,event_type,format,location,location_address,city,country,online_url,starts_at,end_at,timezone,max_attendees,status,published_at)
    VALUES(${id},${req.auth!.subjectId},${value.title},${slug},${value.description},${value.shortDescription},${value.coverImageUrl ?? null},${value.eventType},${value.format},${value.location},${value.locationAddress},${value.city},${value.country},${value.onlineUrl ?? null},${new Date(value.startsAt)},${new Date(value.endsAt)},${value.timezone},${value.maxAttendees ?? null},${status},${status === "published" ? sql`NOW()` : sql`NULL`})
    RETURNING id
  `);
  if (!resultRows(created)[0]) return res.status(500).json({ error: "Unable to create event." });
  await syncTopics(id, normalizeTopics(value.topics));
  await db.execute(sql`INSERT INTO event_audit_log(event_id,actor_id,action,metadata) VALUES(${id},${req.auth!.subjectId},${status === "published" ? "published" : "created"},${JSON.stringify({status,topics:normalizeTopics(value.topics)})}::jsonb)`);
  return res.status(201).json({ data: await serializeEvent(id, req.auth!.subjectId) });
});

eventsRouter.patch("/:eventId", requireAgent, async (req, res) => {
  const parsed = eventInputBase.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid event update." });
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  const existing = resultRows<Row>(await db.execute(sql`SELECT id FROM events WHERE id=${id} AND creator_id=${req.auth!.subjectId} LIMIT 1`))[0];
  if (!existing) return res.status(404).json({ error: "Event not found." });
  const value = parsed.data as any;
  if (value.startsAt && value.endsAt && new Date(value.endsAt).getTime() <= new Date(value.startsAt).getTime()) return res.status(400).json({ error: "End time must be after start time." });
  await db.execute(sql`
    UPDATE events SET
      title=COALESCE(${value.title ?? null},title), short_description=COALESCE(${value.shortDescription ?? null},short_description),
      description=COALESCE(${value.description ?? null},description), cover_image_url=COALESCE(${value.coverImageUrl ?? null},cover_image_url),
      event_type=COALESCE(${value.eventType ?? null},event_type), format=COALESCE(${value.format ?? null},format),
      location=COALESCE(${value.location ?? null},location), location_address=COALESCE(${value.locationAddress ?? null},location_address),
      city=COALESCE(${value.city ?? null},city), country=COALESCE(${value.country ?? null},country), online_url=COALESCE(${value.onlineUrl ?? null},online_url),
      starts_at=COALESCE(${value.startsAt ? new Date(value.startsAt) : null},starts_at), end_at=COALESCE(${value.endsAt ? new Date(value.endsAt) : null},end_at),
      timezone=COALESCE(${value.timezone ?? null},timezone), max_attendees=COALESCE(${value.maxAttendees ?? null},max_attendees), updated_at=NOW()
    WHERE id=${id} AND creator_id=${req.auth!.subjectId}
  `);
  if (value.topics) await syncTopics(id, normalizeTopics(value.topics));
  await db.execute(sql`INSERT INTO event_audit_log(event_id,actor_id,action,metadata) VALUES(${id},${req.auth!.subjectId},'updated',${JSON.stringify({fields:Object.keys(value)})}::jsonb)`);
  return res.json({ data: await serializeEvent(id, req.auth!.subjectId) });
});

eventsRouter.post("/:eventId/publish", requireAgent, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  const updated = await db.execute(sql`UPDATE events SET status='published',published_at=COALESCE(published_at,NOW()),updated_at=NOW() WHERE id=${id} AND creator_id=${req.auth!.subjectId} AND status='draft' RETURNING id`);
  if (!resultRows(updated)[0]) return res.status(404).json({ error: "Draft event not found." });
  await db.execute(sql`INSERT INTO event_audit_log(event_id,actor_id,action) VALUES(${id},${req.auth!.subjectId},'published')`);
  return res.json({ data: await serializeEvent(id, req.auth!.subjectId) });
});

eventsRouter.post("/:eventId/cancel", requireAgent, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  const updated = await db.execute(sql`UPDATE events SET status='cancelled',cancelled_at=NOW(),updated_at=NOW() WHERE id=${id} AND creator_id=${req.auth!.subjectId} AND status='published' RETURNING id`);
  if (!resultRows(updated)[0]) return res.status(404).json({ error: "Published event not found." });
  await db.execute(sql`INSERT INTO event_audit_log(event_id,actor_id,action) VALUES(${id},${req.auth!.subjectId},'cancelled')`);
  await db.execute(sql`
    INSERT INTO notifications(recipient_id,actor_id,kind,entity_id,text)
    SELECT er.user_id,${req.auth!.subjectId},'event_cancelled',${id},'An event you were going to has been cancelled.'
    FROM event_rsvps er WHERE er.event_id=${id} AND er.status='going'
  `);
  return res.json({ data: await serializeEvent(id, req.auth!.subjectId) });
});

eventsRouter.delete("/:eventId", requireAgent, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  const deleted = await db.execute(sql`DELETE FROM events WHERE id=${id} AND creator_id=${req.auth!.subjectId} AND status='draft' RETURNING id`);
  if (!resultRows(deleted)[0]) return res.status(404).json({ error: "Draft event not found." });
  return res.json({ data: { deleted: true, id } });
});

eventsRouter.get("/:eventId/attendees", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const result = await db.execute(sql`
    SELECT u.id,u.name,u.username,u.avatar_url,er.status,er.created_at
    FROM event_rsvps er JOIN users u ON u.id=er.user_id
    WHERE er.event_id=${String(req.params.eventId)} AND er.status='going'
    ORDER BY er.created_at ASC LIMIT 200
  `);
  return res.json({ data: resultRows(result) });
});

eventsRouter.post("/:eventId/rsvp", requireAuth, async (req, res) => {
  const id = String(req.params.eventId);
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const event = resultRows<Row>(await db.execute(sql`SELECT id,end_at,status,max_attendees FROM events WHERE id=${id} LIMIT 1`))[0];
  if (!event) return res.status(404).json({ error: "Event not found." });
  if (event.status === "cancelled") return res.status(409).json({ error: "This event has been cancelled." });
  if (new Date(event.end_at).getTime() < Date.now()) return res.status(409).json({ error: "This event has already ended." });
  const existing = resultRows<Row>(await db.execute(sql`SELECT status FROM event_rsvps WHERE event_id=${id} AND user_id=${req.auth!.subjectId} LIMIT 1`))[0];
  const currentCount = Number(resultRows<{ count: number }>(await db.execute(sql`SELECT COUNT(*)::int count FROM event_rsvps WHERE event_id=${id} AND status='going'`))[0]?.count ?? 0);
  if (!existing && event.max_attendees && currentCount >= Number(event.max_attendees)) return res.status(409).json({ error: "This event is full." });
  if (existing) await db.execute(sql`UPDATE event_rsvps SET status='going',updated_at=NOW() WHERE event_id=${id} AND user_id=${req.auth!.subjectId}`);
  else await db.execute(sql`INSERT INTO event_rsvps(event_id,user_id,status,updated_at) VALUES(${id},${req.auth!.subjectId},'going',NOW())`);
  await db.execute(sql`INSERT INTO notifications(recipient_id,actor_id,kind,entity_id,text) SELECT e.creator_id,${req.auth!.subjectId},'event_rsvp',${id},'Someone RSVP’d to your event.' FROM events e WHERE e.id=${id}`);
  return res.json({ data: await serializeEvent(id, req.auth!.subjectId) });
});

eventsRouter.delete("/:eventId/rsvp", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  await db.execute(sql`UPDATE event_rsvps SET status='cancelled',updated_at=NOW() WHERE event_id=${id} AND user_id=${req.auth!.subjectId}`);
  return res.json({ data: await serializeEvent(id, req.auth!.subjectId) });
});

eventsRouter.post("/:eventId/bookmark", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  await db.execute(sql`INSERT INTO event_bookmarks(event_id,user_id) VALUES(${id},${req.auth!.subjectId}) ON CONFLICT DO NOTHING`);
  return res.json({ data: { active: true } });
});

eventsRouter.delete("/:eventId/bookmark", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const id = String(req.params.eventId);
  await db.execute(sql`DELETE FROM event_bookmarks WHERE event_id=${id} AND user_id=${req.auth!.subjectId}`);
  return res.json({ data: { active: false } });
});

eventsRouter.get("/:eventId", async (req, res) => {
  const event = await serializeEvent(String(req.params.eventId), req.auth?.subjectId);
  if (!event) return res.status(404).json({ error: "Event not found." });
  if (event.status === "draft" && event.creatorId !== req.auth?.subjectId) return res.status(404).json({ error: "Event not found." });
  return res.json({ data: event });
});
