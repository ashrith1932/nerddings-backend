import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialFeedViewRouter = Router();

type FeedRow = Record<string, any>;
type QueryResultLike<T> = T[] | { rows: T[] };

async function executeRows<T extends FeedRow>(query: any): Promise<T[]> {
  const result = await db!.execute(query) as unknown as QueryResultLike<T>;
  return Array.isArray(result) ? result : result.rows;
}

const clamp = (v: number, min = 0, max = 1) => Math.max(min, Math.min(max, v));

const score = (r: FeedRow) => {
  const age = Math.max(0.1, (Date.now() - new Date(r.created_at).getTime()) / 36e5);
  const fresh = 1 / Math.pow(1 + age / 8, 0.65);
  const eng = Math.log1p(
    Number(r.likes) +
      Number(r.comments) * 2 +
      Number(r.reposts) * 2.5 +
      Number(r.saves),
  ) / 10;

  return (
    fresh * 0.28 +
    eng * 0.2 +
    clamp(Number(r.proof_of_work_score) / 2) * 0.16 +
    clamp(Number(r.trust_score) / 100) * 0.12 +
    (r.is_following ? 1 : 0) * 0.1 +
    clamp(Number(r.meaningful_engagement_score) / 2) * 0.14 -
    clamp(Number(r.spam_penalty) / 2) * 0.2
  );
};

socialFeedViewRouter.get("/feed", async (req, res) => {
  if (!db) return res.json({ data: [], algorithm: "nerddings-v3", mode: "for-you" });

  try {
    const mode = req.query.mode === "network" ? "network" : "for-you";
    const viewer = req.auth?.subjectId;

    const network =
      mode === "network" && viewer
        ? sql`AND (
            p.author_id = ${viewer}
            OR EXISTS (
              SELECT 1 FROM follows f2
              WHERE f2.follower_id = ${viewer}
                AND f2.following_id = p.author_id
            )
          )`
        : sql``;

    const viewerJoin = viewer
      ? sql`LEFT JOIN follows vf
          ON vf.follower_id = ${viewer}
         AND vf.following_id = p.author_id`
      : sql``;

    const rows = await executeRows<FeedRow>(sql`
      SELECT
        p.id,
        p.author_id,
        p.body,
        p.created_at,
        p.project_id,
        p.proof_of_work_score,
        p.meaningful_engagement_score,
        p.spam_penalty,
        p.link_url,
        p.quote_post_id,

        u.name,
        u.username,
        u.avatar_url,
        u.account_type,
        u.bio,
        u.location,
        u.trust_score,

        pr.name AS project_name,
        pr.slug AS project_slug,
        pr.stage AS project_stage,
        pr.description AS project_description,
        pr.github_url AS project_github_url,

        COUNT(DISTINCT pl.user_id)::int AS likes,
        COUNT(DISTINCT pc.id)::int AS comments,
        COUNT(DISTINCT rr.user_id)::int AS reposts,
        COUNT(DISTINCT ps.user_id)::int AS saves,

        COALESCE(BOOL_OR(vf.follower_id IS NOT NULL), false) AS is_following,

        COALESCE(
          (
            SELECT json_agg(
              json_build_object(
                'publicUrl', pm.public_url,
                'mimeType', pm.mime_type
              ) ORDER BY pm.sort_order
            )
            FROM post_media pm
            WHERE pm.post_id = p.id
          ),
          '[]'::json
        ) AS media

      FROM posts p
      JOIN users u ON u.id = p.author_id
      LEFT JOIN projects pr ON pr.id = p.project_id
      LEFT JOIN post_likes pl ON pl.post_id = p.id
      LEFT JOIN post_comments pc ON pc.post_id = p.id
      LEFT JOIN post_reposts rr ON rr.post_id = p.id
      LEFT JOIN post_saves ps ON ps.post_id = p.id
      ${viewerJoin}
      WHERE 1 = 1
        ${network}
      GROUP BY p.id, u.id, pr.id
      ORDER BY p.created_at DESC
      LIMIT 160
    `);

    const ranked: FeedRow[] = rows
      .map((row: FeedRow): FeedRow => ({ ...row, score: score(row) }))
      .sort((a: FeedRow, b: FeedRow) => Number(b.score) - Number(a.score))
      .slice(0, 50);

    let states: FeedRow[] = [];

    if (viewer && ranked.length) {
      const ids = ranked.map((row: FeedRow) => String(row.id));

      states = await executeRows<FeedRow>(sql`
        SELECT
          p.id,
          EXISTS(
            SELECT 1 FROM post_likes x
            WHERE x.post_id = p.id AND x.user_id = ${viewer}
          ) AS viewer_liked,
          EXISTS(
            SELECT 1 FROM post_saves x
            WHERE x.post_id = p.id AND x.user_id = ${viewer}
          ) AS viewer_saved,
          EXISTS(
            SELECT 1 FROM post_reposts x
            WHERE x.post_id = p.id AND x.user_id = ${viewer}
          ) AS viewer_reposted
        FROM posts p
        WHERE p.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})
      `);
    }

    const stateMap = new Map(states.map((state) => [String(state.id), state]));

    const data = ranked.map((row: FeedRow) => {
      const state = stateMap.get(String(row.id)) ?? {};

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
        score: Math.round(Number(row.score) * 1000) / 1000,
        likes: Number(row.likes || 0),
        comments: Number(row.comments || 0),
        reposts: Number(row.reposts || 0),
        saves: Number(row.saves || 0),
        liked: Boolean(state.viewer_liked),
        saved: Boolean(state.viewer_saved),
        reposted: Boolean(state.viewer_reposted),
        following: Boolean(row.is_following),
        linkUrl: row.link_url ?? null,
        media: row.media || [],
        project: row.project_id
          ? {
              id: row.project_id,
              name: row.project_name,
              slug: row.project_slug,
              stage: row.project_stage,
              description: row.project_description,
              githubUrl: row.project_github_url ?? null,
            }
          : null,
        quotePostId: row.quote_post_id ?? null,
        quotePost: null,
      };
    });

    return res.json({
      data,
      algorithm: "nerddings-v3-transparent-interest-score",
      mode,
    });
  } catch (error) {
    console.error("[SocialFeed] Failed to load feed:", error);
    return res.status(500).json({ error: "Unable to load feed" });
  }
});
