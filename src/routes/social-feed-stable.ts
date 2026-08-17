import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

type Row = Record<string, any>;

export const socialFeedStableRouter = Router();

function rows<T extends Row>(result: unknown): T[] {
  const value = result as T[] | { rows?: T[] };
  return Array.isArray(value) ? value : value.rows ?? [];
}

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
  const viewer = viewerId ? sql`LEFT JOIN follows vf ON vf.follower_id=${viewerId} AND vf.following_id=p.author_id` : sql`LEFT JOIN follows vf ON FALSE`;
  const result = await db.execute(sql`
    SELECT p.id,p.author_id,p.body,p.link_url,p.created_at,p.project_id,p.quote_post_id,
      p.proof_of_work_score,p.meaningful_engagement_score,p.spam_penalty,
      u.name,u.username,u.avatar_url,u.account_type,u.bio,u.location,u.trust_score,
      pr.name project_name,pr.slug project_slug,pr.stage project_stage,pr.description project_description,pr.github_url,
      COUNT(DISTINCT pl.user_id)::int likes,
      COUNT(DISTINCT pc.id)::int comments,
      COUNT(DISTINCT rr.user_id)::int reposts,
      COUNT(DISTINCT ps.user_id)::int saves,
      COALESCE(BOOL_OR(vf.follower_id IS NOT NULL),false) is_following,
      EXISTS(SELECT 1 FROM post_likes vl WHERE vl.post_id=p.id AND vl.user_id=${viewerId ?? null}) viewer_liked,
      EXISTS(SELECT 1 FROM post_saves vs WHERE vs.post_id=p.id AND vs.user_id=${viewerId ?? null}) viewer_saved,
      EXISTS(SELECT 1 FROM post_reposts vr WHERE vr.post_id=p.id AND vr.user_id=${viewerId ?? null}) viewer_reposted,
      COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media
    FROM posts p JOIN users u ON u.id=p.author_id
    LEFT JOIN projects pr ON pr.id=p.project_id
    LEFT JOIN post_likes pl ON pl.post_id=p.id LEFT JOIN post_comments pc ON pc.post_id=p.id
    LEFT JOIN post_reposts rr ON rr.post_id=p.id LEFT JOIN post_saves ps ON ps.post_id=p.id
    ${viewer}
    GROUP BY p.id,u.id,pr.id ORDER BY p.created_at DESC LIMIT 160
  `);
  return rows(result).map(row => ({ ...row, score: score(row) })).sort((a,b) => Number(b.score)-Number(a.score)).slice(0,50);
}

function serialize(row: Row) {
  return {
    id: row.id, authorId: row.author_id,
    author: { id: row.author_id, name: row.name, username: row.username, avatarUrl: row.avatar_url, accountType: row.account_type, bio: row.bio, location: row.location },
    text: row.body, createdAt: row.created_at,
    score: Math.round(Number(row.score ?? 0) * 1000) / 1000,
    likes: Number(row.likes ?? 0), comments: Number(row.comments ?? 0), reposts: Number(row.reposts ?? 0), saves: Number(row.saves ?? 0),
    liked: Boolean(row.viewer_liked), saved: Boolean(row.viewer_saved), reposted: Boolean(row.viewer_reposted), following: Boolean(row.is_following),
    linkUrl: row.link_url ?? null, media: row.media ?? [],
    project: row.project_id ? { id: row.project_id, name: row.project_name, slug: row.project_slug, stage: row.project_stage, description: row.project_description, githubUrl: row.github_url ?? null } : null,
    quotePostId: row.quote_post_id ?? null,
  };
}

socialFeedStableRouter.get("/feed", async (req,res) => {
  try {
    const mode = req.query.mode === "network" ? "network" : "for-you";
    const viewerId = req.auth?.subjectId;
    let result = await loadPosts(viewerId);
    if (mode === "network" && viewerId) result = result.filter(row => row.author_id === viewerId || row.is_following);
    return res.json({ data: result.map(serialize), algorithm: "nerddings-v4", mode });
  } catch (error) {
    console.error("[SocialFeedStable] Failed to load feed:", error);
    return res.status(500).json({ error: "Unable to load feed" });
  }
});

socialFeedStableRouter.get("/explore/live", async (_req,res) => {
  try {
    const result = await loadPosts();
    const topics = new Map<string,{topic:string;posts:number;engagement:number}>();
    for (const row of result) {
      const topic = String(row.project_name || "Builds");
      const current = topics.get(topic) ?? { topic, posts:0, engagement:0 };
      current.posts += 1; current.engagement += Number(row.likes)+Number(row.comments)*2+Number(row.reposts)*2; topics.set(topic,current);
    }
    return res.json({ data:{ stories:result.slice(0,30).map(serialize), topics:[...topics.values()].sort((a,b)=>b.engagement-a.engagement).slice(0,12)] }, algorithm:"velocity-recency-quality-v3" });
  } catch (error) {
    console.error("[SocialFeedStable] Failed to load explore:", error);
    return res.status(500).json({ error:"Unable to load explore" });
  }
});
