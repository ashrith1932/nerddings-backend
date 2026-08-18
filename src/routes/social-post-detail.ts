import { Router } from "express";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { createSignedReadUrl } from "../lib/storage.js";

export const socialPostDetailRouter = Router();
type Row = Record<string, any>;

async function executeRows(query: any): Promise<Row[]> {
  const result = await db!.execute(query) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
}

async function serializeMedia(media: Row[]) {
  return Promise.all(media.map(async (item) => ({
    publicUrl: (await createSignedReadUrl(String(item.storage_path ?? ""))) ?? item.public_url ?? null,
    mimeType: item.mime_type,
  })));
}

function serializePost(row: Row, media: Row[], commentsTree: Row[]) {
  return {
    id: row.id,
    authorId: row.author_id,
    author: { id: row.author_id, name: row.name, username: row.username, avatarUrl: row.avatar_url, accountType: row.account_type, bio: row.bio, location: row.location },
    text: row.body,
    createdAt: row.created_at,
    score: Number(row.proof_of_work_score ?? 0),
    likes: Number(row.likes ?? 0),
    comments: Number(row.comments ?? 0),
    reposts: Number(row.reposts ?? 0),
    saves: Number(row.saves ?? 0),
    views: Number(row.views ?? 0),
    proofOfWorkScore: Number(row.proof_of_work_score ?? 0),
    linkUrl: row.link_url ?? null,
    liked: Boolean(row.viewer_liked),
    saved: Boolean(row.viewer_saved),
    reposted: Boolean(row.viewer_reposted),
    project: row.project_id ? { id: row.project_id, name: row.project_name, slug: row.project_slug, stage: row.project_stage, description: row.project_description, githubUrl: row.github_url } : null,
    quotePostId: row.quote_post_id ?? null,
    media,
    commentsTree,
  };
}

async function loadComments(postId: string) {
  const rows = await executeRows(sql`
    SELECT c.id,c.post_id,c.parent_id,c.body,c.created_at,u.id AS author_id,u.name,u.username,u.avatar_url
    FROM post_comments c
    JOIN users u ON u.id=c.author_id
    WHERE c.post_id=${postId}
    ORDER BY c.created_at ASC
  `);
  const byParent = new Map<string | null, any[]>();
  for (const row of rows) {
    const item = { id: String(row.id), postId: String(row.post_id), parentId: row.parent_id == null ? null : String(row.parent_id), body: String(row.body), createdAt: String(row.created_at), author: { id: row.author_id, name: row.name, username: row.username, avatarUrl: row.avatar_url }, replies: [] as any[] };
    const key = item.parentId;
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }
  const attach = (items: any[]): any[] => items.map((item) => ({ ...item, replies: attach(byParent.get(item.id) ?? []) }));
  return attach(byParent.get(null) ?? []);
}

socialPostDetailRouter.get("/posts/:postId", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Post not found" });
  try {
    const postRows = await executeRows(sql`
      SELECT p.id,p.author_id,p.body,p.link_url,p.proof_of_work_score,p.created_at,p.project_id,p.quote_post_id,
             u.name,u.username,u.avatar_url,u.account_type,u.bio,u.location,
             pr.name project_name,pr.slug project_slug,pr.stage project_stage,pr.description project_description,pr.github_url,
             (SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,
             (SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,
             (SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,
             (SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves,
             (SELECT COUNT(*)::int FROM post_views x WHERE x.post_id=p.id) views,
             ${req.auth?.subjectId ? sql`EXISTS(SELECT 1 FROM post_likes x WHERE x.post_id=p.id AND x.user_id=${req.auth.subjectId})` : sql`false`} viewer_liked,
             ${req.auth?.subjectId ? sql`EXISTS(SELECT 1 FROM post_saves x WHERE x.post_id=p.id AND x.user_id=${req.auth.subjectId})` : sql`false`} viewer_saved,
             ${req.auth?.subjectId ? sql`EXISTS(SELECT 1 FROM post_reposts x WHERE x.post_id=p.id AND x.user_id=${req.auth.subjectId})` : sql`false`} viewer_reposted
      FROM posts p JOIN users u ON u.id=p.author_id LEFT JOIN projects pr ON pr.id=p.project_id
      WHERE p.id=${req.params.postId} LIMIT 1
    `);
    const post = postRows[0];
    if (!post) return res.status(404).json({ error: "Post not found" });

    if (req.auth?.subjectId) {
      const inserted = await executeRows(sql`
        INSERT INTO post_views(id,post_id,user_id)
        VALUES (${randomUUID()},${req.params.postId},${req.auth.subjectId})
        ON CONFLICT (post_id,user_id) DO NOTHING
        RETURNING id
      `);
      if (inserted[0]) post.views = Number(post.views ?? 0) + 1;
    }

    const mediaRows = await executeRows(sql`SELECT storage_path,public_url,mime_type FROM post_media WHERE post_id=${req.params.postId} ORDER BY sort_order ASC`);
    const media = await serializeMedia(mediaRows);
    const commentsTree = await loadComments(String(req.params.postId));
    return res.json({ data: serializePost(post, media, commentsTree) });
  } catch (error) {
    console.error("[Social] Failed to load post detail:", error);
    return res.status(500).json({ error: "This post could not be loaded right now." });
  }
});

socialPostDetailRouter.post("/posts/:postId/comments", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const parsed = z.object({ body: z.string().trim().min(1).max(2000), parentId: z.string().uuid().nullable().optional() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Comment cannot be empty." });
  try {
    const exists = await executeRows(sql`SELECT id FROM posts WHERE id=${req.params.postId} LIMIT 1`);
    if (!exists[0]) return res.status(404).json({ error: "Post not found" });

    if (parsed.data.parentId) {
      const parent = await executeRows(sql`SELECT id FROM post_comments WHERE id=${parsed.data.parentId} AND post_id=${req.params.postId} LIMIT 1`);
      if (!parent[0]) return res.status(400).json({ error: "That reply target does not belong to this post." });
    }

    const [row] = await executeRows(sql`
      INSERT INTO post_comments (id,post_id,author_id,parent_id,body)
      VALUES (${randomUUID()},${req.params.postId},${req.auth!.subjectId},${parsed.data.parentId ?? null},${parsed.data.body})
      RETURNING id,post_id,parent_id,body,created_at
    `);
    return res.status(201).json({ data: row });
  } catch (error) {
    console.error("[Social] Failed to add post comment:", error);
    return res.status(500).json({ error: "Comment could not be posted right now." });
  }
});
