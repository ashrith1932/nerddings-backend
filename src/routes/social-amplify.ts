import { Router } from "express";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { notifications, postReposts, posts } from "../db/schema.js";
import { eq, sql } from "drizzle-orm";

export const socialAmplifyRouter = Router();

socialAmplifyRouter.post("/posts/:postId/repost", requireAuth, async (req, res) => {
  const postId = String(req.params.postId);

  if (!db) {
    return res.json({ data: { action: "repost", active: true } });
  }

  try {
    const [post] = await db.select({ id: posts.id, authorId: posts.authorId }).from(posts).where(eq(posts.id, postId)).limit(1);
    if (!post) return res.status(404).json({ error: "Post not found." });

    await db.insert(postReposts).values({ id: randomUUID(), postId, userId: req.auth!.subjectId });

    if (post.authorId !== req.auth!.subjectId) {
      await db.insert(notifications).values({
        recipientId: post.authorId,
        actorId: req.auth!.subjectId,
        kind: "repost",
        entityId: postId,
        text: "nerdded your post",
      });
    }

    const [{ count }] = await db.select({ count: sql<number>`count(*)` }).from(postReposts).where(eq(postReposts.postId, postId));

    return res.json({
      data: {
        action: "repost",
        active: true,
        count: Number(count ?? 0),
      },
    });
  } catch (error) {
    console.error("[Social] Failed to amplify post:", error);
    return res.status(500).json({ error: "That amplification could not be saved." });
  }
});
