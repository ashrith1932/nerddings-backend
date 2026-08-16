import { Router } from "express";
import { feedPosts } from "../lib/store.js";
import { rankFeed } from "../lib/ranking.js";
import { db } from "../db/client.js";
import { posts } from "../db/schema.js";
import { desc } from "drizzle-orm";

export const feedRouter = Router();

feedRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  if (db) {
    const rows = await db.select().from(posts).orderBy(desc(posts.createdAt)).limit(limit);
    return res.json({ data: rows.map((post) => ({ id: post.id, authorId: post.authorId, text: post.body, topic: "build", createdAt: post.createdAt.toISOString(), signals: { relevance: 0.7, freshness: 1, proofOfWork: Number(post.proofOfWorkScore), meaningfulEngagement: Number(post.meaningfulEngagementScore), trust: 0.5, projectActivity: 0.4, relationship: 0.5, spamPenalty: Number(post.spamPenalty) } })), algorithm: "nerdding-v1-transparent-score" });
  }
  res.json({ data: rankFeed(feedPosts).slice(0, limit), algorithm: "nerdding-v1-transparent-score" });
});
