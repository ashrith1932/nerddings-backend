import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { feedPosts } from "../lib/store.js";
import { db } from "../db/client.js";
import { notifications, postComments, postMedia, posts, postLikes, postSaves, postReposts, follows as followsTable } from "../db/schema.js";
import { and, eq, sql } from "drizzle-orm";

const actionState = new Map<string, { likes: Set<string>; saves: Set<string>; reposts: Set<string> }>();
const comments = new Map<string, { id: string; postId: string; authorId: string; body: string; createdAt: string }[]>();
const following = new Map<string, Set<string>>();

function stateFor(postId: string) {
  const found = actionState.get(postId);
  if (found) return found;
  const created = { likes: new Set<string>(), saves: new Set<string>(), reposts: new Set<string>() };
  actionState.set(postId, created);
  return created;
}

export const socialRouter = Router();

async function notifyPostOwner(postId: string, actorId: string, kind: string, text: string) {
  if (!db) return;
  const [post] = await db.select({ authorId: posts.authorId }).from(posts).where(eq(posts.id, postId)).limit(1);
  if (post && post.authorId !== actorId) await db.insert(notifications).values({ recipientId: post.authorId, actorId, kind, entityId: postId, text });
}

socialRouter.post("/posts", requireAuth, async (req, res) => {
  const parsed = z.object({
    body: z.string().min(1).max(5000),
    topic: z.string().max(80).default("build"),
    projectSlug: z.string().max(100).optional(),
    linkUrl: z.string().url().max(2000).nullable().optional(),
    quotePostId: z.string().uuid().nullable().optional(),
    media: z.array(z.object({ path: z.string(), mimeType: z.string(), publicUrl: z.string().url().optional() })).max(10).default([]),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Write an update before publishing.", details: parsed.error.flatten() });
  const id = randomUUID();

  if (db) {
    try {
      let projectId: string | null = null;
      if (parsed.data.projectSlug) {
        const projectRows = await db.execute(sql`
          SELECT id FROM projects
          WHERE lower(slug)=lower(${parsed.data.projectSlug}) AND owner_id=${req.auth!.subjectId}
          LIMIT 1
        `) as unknown as Array<{ id: string }>;
        if (!projectRows[0]) return res.status(403).json({ error: "You can only attach projects you own." });
        projectId = projectRows[0].id;
      }

      let quotePostId: string | null = null;
      if (parsed.data.quotePostId) {
        const quoteRows = await db.execute(sql`
          SELECT id FROM posts WHERE id=${parsed.data.quotePostId} LIMIT 1
        `) as unknown as Array<{ id: string }>;
        if (!quoteRows[0]) return res.status(404).json({ error: "The post you are amplifying no longer exists." });
        quotePostId = quoteRows[0].id;
      }

      const [created] = await db.insert(posts).values({
        id,
        authorId: req.auth!.subjectId,
        body: parsed.data.body,
        projectId,
        quotePostId,
        linkUrl: parsed.data.linkUrl ?? null,
        proofOfWorkScore: parsed.data.media.length ? "0.7" : "0",
      }).returning();

      if (parsed.data.media.length) {
        await db.insert(postMedia).values(parsed.data.media.map((media, index) => ({
          postId: created?.id ?? id,
          storagePath: media.path,
          publicUrl: media.publicUrl,
          mimeType: media.mimeType,
          sortOrder: index,
        })));
      }

      return res.status(201).json({ data: {
        id: created?.id ?? id,
        body: parsed.data.body,
        projectId,
        projectSlug: parsed.data.projectSlug ?? null,
        quotePostId,
        linkUrl: parsed.data.linkUrl ?? null,
        media: parsed.data.media,
      } });
    } catch (error) {
      console.error("[Social] Failed to create post:", error);
      return res.status(500).json({ error: "Unable to publish this post right now." });
    }
  }

  feedPosts.unshift({ id, authorId: req.auth!.subjectId, text: parsed.data.body, topic: parsed.data.topic, createdAt: new Date().toISOString(), projectSlug: parsed.data.projectSlug, quotePostId: parsed.data.quotePostId ?? undefined, signals: { relevance: 0.7, freshness: 1, proofOfWork: parsed.data.media.length ? 0.7 : 0.25, meaningfulEngagement: 0, trust: 0.5, projectActivity: 0.4, relationship: 0.5, spamPenalty: 0 } });
  return res.status(201).json({ data: { id, body: parsed.data.body, projectSlug: parsed.data.projectSlug ?? null, quotePostId: parsed.data.quotePostId ?? null, linkUrl: parsed.data.linkUrl ?? null, media: parsed.data.media } });
});

socialRouter.get("/posts/:postId/comments", (req, res) => res.json({ data: comments.get(String(req.params.postId)) ?? [] }));

socialRouter.post("/posts/:postId/comments", requireAuth, async (req, res) => {
  const postId = String(req.params.postId);
  const parsed = z.object({ body: z.string().min(1).max(1000) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Comment cannot be empty." });
  const item = { id: randomUUID(), postId, authorId: req.auth!.subjectId, body: parsed.data.body, createdAt: new Date().toISOString() };
  const current = comments.get(postId) ?? [];
  current.push(item); comments.set(postId, current);
  if (db) await db.insert(postComments).values({ id: item.id, postId, authorId: req.auth!.subjectId, body: item.body });
  await notifyPostOwner(postId, req.auth!.subjectId, "comment", "commented on your post");
  return res.status(201).json({ data: item });
});

socialRouter.post("/posts/:postId/:action", requireAuth, async (req, res) => {
  const postId = String(req.params.postId);
  const action = String(req.params.action);
  if (!["like", "save", "repost"].includes(action)) return res.status(404).json({ error: "Unknown post action." });
  if (db) {
    try {
      const table = action === "like" ? postLikes : action === "save" ? postSaves : postReposts;
      const where = and(eq(table.postId, postId), eq(table.userId, req.auth!.subjectId));
      const [existing] = await db.select().from(table).where(where).limit(1);
      if (existing) await db.delete(table).where(where);
      else await db.insert(table).values({ postId, userId: req.auth!.subjectId });
      if (!existing && action !== "save") await notifyPostOwner(postId, req.auth!.subjectId, action, action === "like" ? "liked your post" : "nerdded your post");
      return res.json({ data: { action, active: !existing } });
    } catch (error) {
      console.error(`[Social] Failed to ${action} post:`, error);
      return res.status(500).json({ error: "That post action could not be saved." });
    }
  }
  const state = stateFor(postId);
  const target = action === "like" ? state.likes : action === "save" ? state.saves : state.reposts;
  const added = target.has(req.auth!.subjectId) ? (target.delete(req.auth!.subjectId), false) : (target.add(req.auth!.subjectId), true);
  return res.json({ data: { action, active: added, counts: { likes: state.likes.size, saves: state.saves.size, reposts: state.reposts.size } } });
});

socialRouter.post("/users/:userId/follow", requireAuth, async (req, res) => {
  const userId = String(req.params.userId);
  if (userId === req.auth!.subjectId) return res.status(400).json({ error: "You cannot follow yourself." });
  if (db) {
    const where = and(eq(followsTable.followerId, req.auth!.subjectId), eq(followsTable.followingId, userId));
    const [existing] = await db.select().from(followsTable).where(where).limit(1);
    if (existing) await db.delete(followsTable).where(where);
    else await db.insert(followsTable).values({ followerId: req.auth!.subjectId, followingId: userId });
    if (!existing) await db.insert(notifications).values({ recipientId: userId, actorId: req.auth!.subjectId, kind: "follow", entityId: userId, text: "started following you" });
    return res.json({ data: { active: !existing, followingId: userId } });
  }
  const set = following.get(req.auth!.subjectId) ?? new Set<string>();
  const active = set.has(userId) ? (set.delete(userId), false) : (set.add(userId), true);
  following.set(req.auth!.subjectId, set);
  return res.json({ data: { active, followingId: userId } });
});

socialRouter.get("/users/:userId/following", requireAuth, async (req, res) => {
  const userId = String(req.params.userId);
  if (db) {
    const [existing] = await db.select().from(followsTable).where(and(eq(followsTable.followerId, req.auth!.subjectId), eq(followsTable.followingId, userId))).limit(1);
    return res.json({ data: { active: Boolean(existing) } });
  }
  return res.json({ data: { active: following.get(req.auth!.subjectId)?.has(userId) ?? false } });
});
