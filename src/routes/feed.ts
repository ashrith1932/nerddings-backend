import { Router } from "express";
import { feedPosts } from "../lib/store.js";
import { rankFeed } from "../lib/ranking.js";
import { db } from "../db/client.js";
import { postMedia, posts, users } from "../db/schema.js";
import { desc, eq, inArray } from "drizzle-orm";

export const feedRouter = Router();

feedRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (db) {
    const rows = await db.select({ post: posts, author: users }).from(posts).innerJoin(users, eq(posts.authorId, users.id)).orderBy(desc(posts.createdAt)).limit(limit);
    const mediaRows = rows.length ? await db.select().from(postMedia).where(inArray(postMedia.postId, rows.map(({ post }) => post.id))) : [];
    return res.json({ data: rows.map(({ post, author }) => ({ id: post.id, authorId: post.authorId, author: { id: author.id, name: author.name, username: author.username, accountType: author.accountType, avatarUrl: author.avatarUrl }, text: post.body, topic: "build", createdAt: post.createdAt.toISOString(), media: mediaRows.filter((media) => media.postId === post.id).sort((a, b) => a.sortOrder - b.sortOrder).map((media) => ({ publicUrl: media.publicUrl, mimeType: media.mimeType })), signals: { relevance: 0.7, freshness: 1, proofOfWork: Number(post.proofOfWorkScore), meaningfulEngagement: Number(post.meaningfulEngagementScore), trust: 0.5, projectActivity: 0.4, relationship: 0.5, spamPenalty: Number(post.spamPenalty) } })), algorithm: "nerdding-v1-transparent-score" });
  }
  res.json({ data: rankFeed(feedPosts).slice(0, limit), algorithm: "nerdding-v1-transparent-score" });
});
