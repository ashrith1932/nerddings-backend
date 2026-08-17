import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

type Row = Record<string, any>;
export const socialFeedStableRouter = Router();

function rows<T extends Row>(result: unknown): T[] {
  const value = result as T[] | { rows?: T[] };
  return Array.isArray(value) ? value : value.rows ?? [];
}
function clamp(value: number, min = 0, max = 1) { return Math.max(min, Math.min(max, value)); }
function safeHours(value: string) { return Math.max(0.05, (Date.now() - new Date(value).getTime()) / 36e5); }
function normalizeTag(tag: string) { return tag.trim().replace(/^#/, "").toLowerCase().slice(0, 64); }
function score(row: Row, tagVelocity: Map<string, number>) {
  const ageHours = safeHours(row.created_at);
  const freshness = 1 / Math.sqrt(1 + ageHours / 72);
  const engagementRaw = Number(row.likes) + Number(row.comments) * 2 + Number(row.reposts) * 2.5 + Number(row.saves);
  const engagementVelocity = clamp(Math.log1p(engagementRaw) / 7) * (1 / Math.sqrt(1 + ageHours / 24));
  const quality = clamp(Number(row.proof_of_work_score) / 2) * 0.55 + clamp(Number(row.trust_score) / 100) * 0.45;
  const relationship = row.is_following ? 1 : 0;
  const tagAffinity = Number(row.tag_affinity ?? 0);
  const tags = Array.isArray(row.hashtags) ? row.hashtags : [];
  const topicVelocity = tags.length ? Math.max(...tags.map((tag: string) => tagVelocity.get(String(tag)) ?? 0)) : 0;
  const spamPenalty = clamp(Number(row.spam_penalty) / 2);
  const networkBoost = row.mode === "network" ? relationship * 0.18 : relationship * 0.08;
  return freshness * 0.16 + engagementVelocity * 0.24 + quality * 0.16 + networkBoost + clamp(tagAffinity / 5) * 0.20 + topicVelocity * 0.12 + clamp(Number(row.meaningful_engagement_score) / 2) * 0.08 - spamPenalty * 0.18;
}

async function loadPosts(viewerId?: string, mode: "for-you" | "network" = "for-you"): Promise<Row[]> {
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
      COALESCE((SELECT COUNT(*)::int FROM post_views pv WHERE pv.post_id=p.id),0) views,
      COALESCE(BOOL_OR(vf.follower_id IS NOT NULL),false) is_following,
      EXISTS(SELECT 1 FROM post_likes vl WHERE vl.post_id=p.id AND vl.user_id=${viewerId ?? null}) viewer_liked,
      EXISTS(SELECT 1 FROM post_saves vs WHERE vs.post_id=p.id AND vs.user_id=${viewerId ?? null}) viewer_saved,
      EXISTS(SELECT 1 FROM post_reposts vr WHERE vr.post_id=p.id AND vr.user_id=${viewerId ?? null}) viewer_reposted,
      COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media,
      COALESCE((SELECT json_agg(h.tag ORDER BY h.tag) FROM post_hashtags ph JOIN hashtags h ON h.id=ph.hashtag_id WHERE ph.post_id=p.id),'[]'::json) hashtags
    FROM posts p JOIN users u ON u.id=p.author_id
    LEFT JOIN projects pr ON pr.id=p.project_id
    LEFT JOIN post_likes pl ON pl.post_id=p.id LEFT JOIN post_comments pc ON pc.post_id=p.id
    LEFT JOIN post_reposts rr ON rr.post_id=p.id LEFT JOIN post_saves ps ON ps.post_id=p.id
    ${viewer}
    GROUP BY p.id,u.id,pr.id ORDER BY p.created_at DESC LIMIT 180
  `);
  let resultRows = rows(result);
  if (mode === "network" && viewerId) resultRows = resultRows.filter(row => row.author_id === viewerId || row.is_following);

  let affinity = new Map<string, number>();
  if (viewerId) {
    try {
      const affinityRows = await db.execute(sql`
        SELECT h.tag, COUNT(*)::int weight
        FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id=h.id
        JOIN post_likes l ON l.post_id=ph.post_id
        WHERE l.user_id=${viewerId}
        GROUP BY h.tag
      `);
      affinity = new Map(rows(affinityRows).map(row => [String(row.tag), Number(row.weight)]));
    } catch {}
  }
  const tagVelocity = new Map<string, number>();
  for (const row of resultRows) {
    const engagement = Math.log1p(Number(row.likes) + Number(row.comments) * 2 + Number(row.reposts) * 2.5 + Number(row.saves)) / 7;
    const hashtags = Array.isArray(row.hashtags) ? row.hashtags : [];
    for (const tag of hashtags) {
      const previous = tagVelocity.get(String(tag)) ?? 0;
      tagVelocity.set(String(tag), Math.max(previous, clamp(engagement)));
    }
  }
  return resultRows
    .map(row => {
      const hashtags = Array.isArray(row.hashtags) ? row.hashtags : [];
      const tagAffinity = hashtags.reduce((sum: number, tag: string) => sum + (affinity.get(String(tag)) ?? 0), 0);
      return { ...row, mode, tag_affinity: tagAffinity, score: score({ ...row, mode, tag_affinity: tagAffinity }, tagVelocity) };
    })
    .sort((a, b) => Number(b.score) - Number(a.score))
    .slice(0, 50);
}

function serialize(row: Row) {
  return {
    id: row.id, authorId: row.author_id,
    author: { id: row.author_id, name: row.name, username: row.username, avatarUrl: row.avatar_url, accountType: row.account_type, bio: row.bio, location: row.location },
    text: row.body, createdAt: row.created_at,
    score: Math.round(Number(row.score ?? 0) * 1000) / 1000,
    likes: Number(row.likes ?? 0), comments: Number(row.comments ?? 0), reposts: Number(row.reposts ?? 0), saves: Number(row.saves ?? 0), views: Number(row.views ?? 0),
    liked: Boolean(row.viewer_liked), saved: Boolean(row.viewer_saved), reposted: Boolean(row.viewer_reposted), following: Boolean(row.is_following),
    linkUrl: row.link_url ?? null, media: row.media ?? [], hashtags: Array.isArray(row.hashtags) ? row.hashtags : [],
    project: row.project_id ? { id: row.project_id, name: row.project_name, slug: row.project_slug, stage: row.project_stage, description: row.project_description, githubUrl: row.github_url ?? null } : null,
    quotePostId: row.quote_post_id ?? null,
  };
}

socialFeedStableRouter.get("/feed", async (req,res) => {
  try {
    const mode = req.query.mode === "network" ? "network" : "for-you";
    const result = await loadPosts(req.auth?.subjectId, mode);
    return res.json({ data: result.map(serialize), algorithm: "nerddings-relevance-v5", mode });
  } catch (error) {
    console.error("[SocialFeedStable] Failed to load feed:", error);
    return res.status(500).json({ error: "Unable to load feed" });
  }
});

socialFeedStableRouter.get("/feed/recommendation-update", async (req,res) => {
  try {
    const mode = req.query.mode === "network" ? "network" : "for-you";
    const currentIds = new Set(String(req.query.ids ?? "").split(",").map(value => value.trim()).filter(Boolean));
    const result = await loadPosts(req.auth?.subjectId, mode);
    const incoming = result.filter(row => !currentIds.has(String(row.id))).length;
    return res.json({ data: { count: incoming, rankingChanged: incoming > 0 }, algorithm: "nerddings-relevance-v5" });
  } catch (error) {
    console.error("[SocialFeedStable] Failed to check recommendation update:", error);
    return res.json({ data: { count: 0, rankingChanged: false } });
  }
});

socialFeedStableRouter.get("/hashtags/trending", async (_req,res) => {
  try {
    if (!db) return res.json({ data: [] });
    const result = await db.execute(sql`
      SELECT h.tag, COUNT(DISTINCT ph.post_id)::int posts,
        COUNT(DISTINCT l.user_id)::int likes,
        COUNT(DISTINCT c.id)::int comments,
        COUNT(DISTINCT r.user_id)::int reposts
      FROM hashtags h JOIN post_hashtags ph ON ph.hashtag_id=h.id
      JOIN posts p ON p.id=ph.post_id
      LEFT JOIN post_likes l ON l.post_id=p.id
      LEFT JOIN post_comments c ON c.post_id=p.id
      LEFT JOIN post_reposts r ON r.post_id=p.id
      WHERE p.created_at > NOW() - INTERVAL '7 days'
      GROUP BY h.id
      ORDER BY (COUNT(DISTINCT l.user_id) + COUNT(DISTINCT c.id)*2 + COUNT(DISTINCT r.user_id)*2.5) DESC, COUNT(DISTINCT ph.post_id) DESC
      LIMIT 30
    `);
    return res.json({ data: rows(result).map(row => ({ tag: row.tag, posts: Number(row.posts), likes: Number(row.likes), comments: Number(row.comments), reposts: Number(row.reposts) })) });
  } catch (error) {
    console.error("[SocialFeedStable] Trending hashtags failed:", error);
    return res.status(500).json({ error: "Unable to load trending hashtags" });
  }
});

socialFeedStableRouter.get("/hashtags/:tag", async (req,res) => {
  try {
    const tag = normalizeTag(String(req.params.tag));
    if (!tag || !db) return res.json({ data: { tag, posts: [] } });
    const result = await db.execute(sql`
      SELECT p.id,p.author_id,p.body,p.link_url,p.created_at,p.project_id,p.quote_post_id,
        u.name,u.username,u.avatar_url,u.account_type,u.bio,u.location,u.trust_score,
        pr.name project_name,pr.slug project_slug,pr.stage project_stage,pr.description project_description,pr.github_url,
        (SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,
        (SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,
        (SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,
        (SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves,
        (SELECT COUNT(*)::int FROM post_views x WHERE x.post_id=p.id) views,
        COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media,
        COALESCE((SELECT json_agg(h.tag ORDER BY h.tag) FROM post_hashtags ph JOIN hashtags h ON h.id=ph.hashtag_id WHERE ph.post_id=p.id),'[]'::json) hashtags
      FROM posts p JOIN post_hashtags wanted ON wanted.post_id=p.id JOIN hashtags wanted_tag ON wanted_tag.id=wanted.hashtag_id AND wanted_tag.tag=${tag}
      JOIN users u ON u.id=p.author_id LEFT JOIN projects pr ON pr.id=p.project_id
      ORDER BY p.created_at DESC LIMIT 100
    `);
    return res.json({ data: { tag, posts: rows(result).map(serialize) } });
  } catch (error) {
    console.error("[SocialFeedStable] Hashtag failed:", error);
    return res.status(500).json({ error: "Unable to load hashtag" });
  }
});

socialFeedStableRouter.get("/explore/live", async (_req,res) => {
  try {
    const result = await loadPosts();
    const topics = new Map<string,{topic:string;posts:number;engagement:number}>();
    for (const row of result) {
      const tags = Array.isArray(row.hashtags) && row.hashtags.length ? row.hashtags : [String(row.project_name || "Builds")];
      const engagement = Number(row.likes)+Number(row.comments)*2+Number(row.reposts)*2;
      for (const topic of tags) { const current=topics.get(topic) ?? {topic,posts:0,engagement:0}; current.posts+=1; current.engagement+=engagement; topics.set(topic,current); }
    }
    return res.json({ data: { stories: result.slice(0, 30).map(serialize), topics: [...topics.values()].sort((a,b) => b.engagement - a.engagement).slice(0, 12) }, algorithm: "velocity-recency-quality-v4" });
  } catch (error) {
    console.error("[SocialFeedStable] Failed to load explore:", error);
    return res.status(500).json({ error: "Unable to load explore" });
  }
});
