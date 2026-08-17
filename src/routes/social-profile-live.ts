import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialProfileLiveRouter = Router();

type Row = Record<string, any>;

socialProfileLiveRouter.get("/users/:username/profile-live", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Profile not found" });

  const [user] = (await db.execute(sql`
    SELECT id,name,username,email,avatar_url,bio,location,account_type,interests,trust_score,created_at
    FROM users
    WHERE lower(username)=lower(${req.params.username})
    LIMIT 1
  `) as unknown as Row[]);

  if (!user) return res.status(404).json({ error: "Profile not found" });

  const [stats] = (await db.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,
      (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,
      (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,
      (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts
  `) as unknown as Row[]);

  const projects = await db.execute(sql`
    SELECT id,name,slug,description,stage,github_url,created_at
    FROM projects
    WHERE owner_id=${user.id}
    ORDER BY created_at DESC
    LIMIT 24
  `) as unknown as Row[];

  const posts = await db.execute(sql`
    SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.quote_post_id,
      COUNT(DISTINCT pl.user_id)::int likes,
      COUNT(DISTINCT pc.id)::int comments,
      COUNT(DISTINCT pr.user_id)::int reposts,
      COUNT(DISTINCT ps.user_id)::int saves
    FROM posts p
    LEFT JOIN post_likes pl ON pl.post_id=p.id
    LEFT JOIN post_comments pc ON pc.post_id=p.id
    LEFT JOIN post_reposts pr ON pr.post_id=p.id
    LEFT JOIN post_saves ps ON ps.post_id=p.id
    WHERE p.author_id=${user.id}
    GROUP BY p.id
    ORDER BY p.created_at DESC
    LIMIT 50
  `) as unknown as Row[];

  const postIds = posts.map((post) => post.id);
  const media = postIds.length
    ? await db.execute(sql`
        SELECT post_id,public_url,mime_type,sort_order
        FROM post_media
        WHERE post_id IN (${sql.join(postIds.map((id) => sql`${id}`), sql`,`)})
        ORDER BY sort_order ASC, created_at ASC
      `) as unknown as Row[]
    : [];

  const mediaByPost = new Map<string, Row[]>();
  for (const item of media) {
    const list = mediaByPost.get(String(item.post_id)) ?? [];
    list.push(item);
    mediaByPost.set(String(item.post_id), list);
  }

  const [verification] = (await db.execute(sql`
    SELECT organization_name,organization_type,website,domain,status,verification_note,reviewed_at
    FROM agent_verification_requests
    WHERE user_id=${user.id}
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as Row[]);

  return res.json({
    data: {
      user: { ...user, avatarUrl: user.avatar_url },
      stats: stats ?? { followers: 0, following: 0, projects: 0, posts: 0 },
      projects,
      posts: posts.map((post) => ({
        id: post.id,
        authorId: post.author_id,
        text: post.body,
        createdAt: post.created_at,
        projectId: post.project_id,
        quotePostId: post.quote_post_id,
        likes: Number(post.likes ?? 0),
        comments: Number(post.comments ?? 0),
        reposts: Number(post.reposts ?? 0),
        saves: Number(post.saves ?? 0),
        media: (mediaByPost.get(String(post.id)) ?? []).map((item) => ({ publicUrl: item.public_url, mimeType: item.mime_type })),
      })),
      affiliation: verification?.status === "approved" ? verification : null,
    },
  });
});
