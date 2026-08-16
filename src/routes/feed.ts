import { Router } from "express";
import { feedPosts } from "../lib/store.js";
import { rankFeed } from "../lib/ranking.js";
import { db } from "../db/client.js";
import { postComments, postLikes, postMedia, posts, postReposts, postSaves, users } from "../db/schema.js";
import { and, desc, eq, inArray } from "drizzle-orm";

export const feedRouter = Router();

feedRouter.get("/", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 20, 50);
  const database = db;
  if (database) {
    const rows = await database.select({ post: posts, author: users }).from(posts).innerJoin(users, eq(posts.authorId, users.id)).orderBy(desc(posts.createdAt)).limit(limit);
    const mediaRows = rows.length ? await database.select().from(postMedia).where(inArray(postMedia.postId, rows.map(({ post }) => post.id))) : [];
    const data = await Promise.all(rows.map(async ({ post, author }) => {
      const [likes, comments, reposts, liked, saved] = await Promise.all([
        database.select().from(postLikes).where(eq(postLikes.postId, post.id)),
        database.select().from(postComments).where(eq(postComments.postId, post.id)),
        database.select().from(postReposts).where(eq(postReposts.postId, post.id)),
        req.auth ? database.select().from(postLikes).where(and(eq(postLikes.postId, post.id), eq(postLikes.userId, req.auth.subjectId))).limit(1) : Promise.resolve([]),
        req.auth ? database.select().from(postSaves).where(and(eq(postSaves.postId, post.id), eq(postSaves.userId, req.auth.subjectId))).limit(1) : Promise.resolve([]),
      ]);
      return { id: post.id, authorId: post.authorId, author: { id: author.id, name: author.name, username: author.username, accountType: author.accountType, avatarUrl: author.avatarUrl }, text: post.body, topic: "build", createdAt: post.createdAt.toISOString(), likes: likes.length, comments: comments.length, reposts: reposts.length, liked: liked.length > 0, saved: saved.length > 0, media: mediaRows.filter((media) => media.postId === post.id).sort((a, b) => a.sortOrder - b.sortOrder).map((media) => ({ publicUrl: media.publicUrl, mimeType: media.mimeType })), signals: { relevance: 0.7, freshness: 1, proofOfWork: Number(post.proofOfWorkScore), meaningfulEngagement: Number(post.meaningfulEngagementScore), trust: 0.5, projectActivity: 0.4, relationship: 0.5, spamPenalty: Number(post.spamPenalty) } };
    }));
    return res.json({ data, algorithm: "nerdding-v1-transparent-score" });
  }
  res.json({ data: rankFeed(feedPosts).slice(0, limit), algorithm: "nerdding-v1-transparent-score" });
});
