import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { follows, postMedia, postSaves, posts, users } from "../db/schema.js";
import { desc, eq, inArray } from "drizzle-orm";

export const nerddingsRouter = Router();

nerddingsRouter.get("/", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: { savedPosts: [], following: [], stats: { following: 0, savedPosts: 0, collaborations: 0, affiliations: 0 } } });
  const savedRows = await db.select({ post: posts, author: users }).from(postSaves).innerJoin(posts, eq(postSaves.postId, posts.id)).innerJoin(users, eq(posts.authorId, users.id)).where(eq(postSaves.userId, req.auth!.subjectId)).orderBy(desc(postSaves.createdAt)).limit(50);
  const followingRows = await db.select({ user: users }).from(follows).innerJoin(users, eq(follows.followingId, users.id)).where(eq(follows.followerId, req.auth!.subjectId)).orderBy(desc(follows.createdAt)).limit(50);
  const media = savedRows.length ? await db.select().from(postMedia).where(inArray(postMedia.postId, savedRows.map(({ post }) => post.id))) : [];
  return res.json({ data: { savedPosts: savedRows.map(({ post, author }) => ({ id: post.id, body: post.body, createdAt: post.createdAt.toISOString(), author: { id: author.id, name: author.name, username: author.username, avatarUrl: author.avatarUrl }, media: media.filter((item) => item.postId === post.id).sort((a, b) => a.sortOrder - b.sortOrder).map((item) => ({ publicUrl: item.publicUrl, mimeType: item.mimeType })) })), following: followingRows.map(({ user }) => ({ id: user.id, name: user.name, username: user.username, accountType: user.accountType, avatarUrl: user.avatarUrl })), stats: { following: followingRows.length, savedPosts: savedRows.length, collaborations: 0, affiliations: 0 } } });
});
