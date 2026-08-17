import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialFeedHotfixRouter = Router();

type Row = Record<string, any>;

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function score(row: Row) {
  const ageHours = Math.max(0.1, (Date.now() - new Date(row.created_at).getTime()) / 36e5);
  const freshness = 1 / Math.pow(1 + ageHours / 8, 0.65);
  const engagement = Math.log1p(Number(row.likes) + Number(row.comments) * 2 + Number(row.reposts) * 2.5 + Number(row.saves)) / 10;
  return freshness * 0.28 + engagement * 0.2 + clamp(Number(row.proof_of_work_score) / 2) * 0.16 + clamp(Number(row.trust_score) / 100) * 0.12 + (row.is_following ? 1 : 0) * 0.1 + clamp(Number(row.meaningful_engagement_score) / 2) * 0.14 - clamp(Number(row.spam_penalty) / 2) * 0.2;
}

async function loadPosts(viewerId?: string): Promise<Row[]> {
  if (!db) return [];

  const viewerJoin = viewerId
    ? sql`LEFT JOIN follows vf ON vf.follower_id = ${viewerId} AND vf.following_id = p.author_id`
    : sql`LEFT JOIN follows vf ON FALSE`;

  const result = await db.execute(sql`
    SELECT
      p.id, p.author_id, p.body, p.created_at, p.project_id, p.quote_post_id,
      p.proof_of_work_score, p.meaningful_engagement_score, p.spam_penalty,
      u.name, u.username, u.avatar_url, u.account_type, u.bio, u.location, u.trust_score,
      pr.name AS project_name, pr.slug AS project_slug, pr.stage AS project_stage,
      pr.description AS project_description, pr.github_url AS project_github_url,
      COUNT(DISTINCT pl.user_id)::int AS likes,
      COUNT(DISTINCT pc.id)::int AS comments,
      COUNT(DISTINCT rr.user_id)::int AS reposts,
      COUNT(DISTINCT ps.user_id)::int AS saves,
      COALESCE(BOOL_OR(vf.follower_id IS NOT NULL), false) AS is_following,
      COALESCE((
        SELECT json_agg(json_build_object('publicUrl', pm.public_url, 'mimeType', pm.mime_type) ORDER BY pm.sort_order)
        FROM post_media pm WHERE pm.post_id = p.id
      ), '[]'::json) AS media
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN post_likes pl ON pl.post_id = p.id
    LEFT JOIN post_comments pc ON pc.post_id = p.id
    LEFT JOIN post_reposts rr ON rr.post_id = p.id
    LEFT JOIN post_saves ps ON ps.post_id = p.id
    ${viewerJoin}
    GROUP BY p.id, u.id, pr.id
    ORDER BY p.created_at DESC
    LIMIT 160
  `);

  return (result as unknown as Row[])
    .map((row) => ({ ...row, score: score(row) }))
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, 50);
}

function serialize(row: Row) {
  return {
    id: row.id,
    authorId: row.author_id,
    author: {
      id: row.author_id,
      name: row.name,
      username: row.username,
      avatarUrl: row.avatar_url,
      accountType: row.account_type,
      bio: row.bio,
      location: row.location,
    },
    text: row.body,
    createdAt: row.created_at,
    score: Math.round(Number(row.score ?? 0) * 1000) / 1000,
    likes: Number(row.likes ?? 0),
    comments: Number(row.comments ?? 0),
    reposts: Number(row.reposts ?? 0),
    saves: Number(row.saves ?? 0),
    liked: false,
    saved: false,
    reposted: false,
    following: Boolean(row.is_following),
    linkUrl: row.link_url ?? null,
    media: row.media ?? [],
    project: row.project_id ? {
      id: row.project_id,
      name: row.project_name,
      slug: row.project_slug,
      stage: row.project_stage,
      description: row.project_description,
      githubUrl: row.project_github_url ?? null,
    } : null,
    quotePostId: row.quote_post_id ?? null,
  };
}

socialFeedHotfixRouter.get("/feed", async (req, res) => {
  try {
    const mode = req.query.mode === "network" ? "network" : "for-you";
    const viewerId = req.auth?.subjectId;
    let rows = await loadPosts(viewerId);

    if (mode === "network" && viewerId) {
      rows = rows.filter((row) => row.author_id === viewerId || row.is_following);
    }

    return res.json({
      data: rows.map(serialize),
      algorithm: "nerddings-v3-transparent-interest-score",
      mode,
    });
  } catch (error) {
    console.error("[SocialFeedHotfix] Failed to load feed:", error);
    return res.status(500).json({ error: "Unable to load feed" });
  }
});

socialFeedHotfixRouter.get("/explore/live", async (_req, res) => {
  try {
    const rows = await loadPosts();
    const topics = new Map<string, { topic: string; posts: number; engagement: number }>();

    for (const row of rows) {
      const topic = String(row.project_name || "Builds");
      const current = topics.get(topic) ?? { topic, posts: 0, engagement: 0 };
      current.posts += 1;
      current.engagement += Number(row.likes) + Number(row.comments) * 2 + Number(row.reposts) * 2;
      topics.set(topic, current);
    }

    return res.json({
      data: {
        stories: rows.slice(0, 30).map(serialize),
        topics: [...topics.values()].sort((a, b) => b.engagement - a.engagement).slice(0, 12),
      },
      algorithm: "velocity-recency-quality-v2",
    });
  } catch (error) {
    console.error("[SocialFeedHotfix] Failed to load explore:", error);
    return res.status(500).json({ error: "Unable to load explore" });
  }
});
