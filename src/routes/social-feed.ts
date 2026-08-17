import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const socialFeedRouter = Router();

type Row = Record<string, any>;
type CommentNode = {
  id: string;
  postId: string;
  parentId: string | null;
  body: string;
  createdAt: string;
  author: Row;
  replies: CommentNode[];
};

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function feedScore(row: Row, now = Date.now()) {
  const ageHours = Math.max(0.1, (now - new Date(row.created_at).getTime()) / 36e5);
  const freshness = 1 / Math.pow(1 + ageHours / 8, 0.65);
  const engagement = Math.log1p(Number(row.likes) + Number(row.comments) * 2 + Number(row.reposts) * 2.5 + Number(row.saves)) / 10;
  const proof = clamp(Number(row.proof_of_work_score) / 2);
  const trust = clamp(Number(row.trust_score) / 100);
  const relationship = row.is_following ? 1 : 0;
  const replyQuality = clamp(Number(row.meaningful_engagement_score) / 2);
  const spam = clamp(Number(row.spam_penalty) / 2);
  return freshness * 0.28 + engagement * 0.2 + proof * 0.16 + trust * 0.12 + relationship * 0.1 + replyQuality * 0.14 - spam * 0.2;
}

async function postRows(mode: "for-you" | "network", viewerId?: string): Promise<Row[]> {
  if (!db) return [];

  const network = mode === "network" && viewerId
    ? sql`AND (p.author_id = ${viewerId} OR EXISTS (SELECT 1 FROM follows nf WHERE nf.follower_id = ${viewerId} AND nf.following_id = p.author_id))`
    : sql``;

  const viewer = viewerId
    ? sql`LEFT JOIN follows vf ON vf.follower_id = ${viewerId} AND vf.following_id = p.author_id`
    : sql``;

  const result = await db.execute(sql`
    SELECT p.id, p.author_id, p.body, p.proof_of_work_score, p.meaningful_engagement_score, p.spam_penalty,
           p.created_at, p.project_id, p.quote_post_id,
           u.name, u.username, u.avatar_url, u.account_type, u.bio, u.location, u.trust_score,
           pr.name AS project_name, pr.slug AS project_slug, pr.stage AS project_stage,
           pr.description AS project_description, pr.github_url,
           COUNT(DISTINCT pl.user_id)::int AS likes,
           COUNT(DISTINCT pc.id)::int AS comments,
           COUNT(DISTINCT rr.user_id)::int AS reposts,
           COUNT(DISTINCT ps.user_id)::int AS saves,
           BOOL_OR(vf.follower_id IS NOT NULL) AS is_following
    FROM posts p
    JOIN users u ON u.id = p.author_id
    LEFT JOIN projects pr ON pr.id = p.project_id
    LEFT JOIN post_likes pl ON pl.post_id = p.id
    LEFT JOIN post_comments pc ON pc.post_id = p.id
    LEFT JOIN post_reposts rr ON rr.post_id = p.id
    LEFT JOIN post_saves ps ON ps.post_id = p.id
    ${viewer}
    WHERE 1=1 ${network}
    GROUP BY p.id, u.id, pr.id
    ORDER BY p.created_at DESC
    LIMIT 160
  `);

  const ranked: Row[] = (result as unknown as Row[]).map((row): Row => ({
    ...row,
    score: feedScore(row),
  }));

  return ranked.sort((a, b) => Number(b.score) - Number(a.score));
}

function serializePost(row: Row) {
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
    liked: Boolean(row.viewer_liked),
    saved: Boolean(row.viewer_saved),
    reposted: Boolean(row.viewer_reposted),
    following: Boolean(row.is_following),
    proofOfWorkScore: Number(row.proof_of_work_score ?? 0),
    project: row.project_id
      ? {
          id: row.project_id,
          name: row.project_name,
          slug: row.project_slug,
          stage: row.project_stage,
          description: row.project_description,
          githubUrl: row.github_url,
        }
      : null,
    quotePostId: row.quote_post_id ?? null,
  };
}

socialFeedRouter.get("/feed", async (req, res) => {
  if (!db) return res.json({ data: [], algorithm: "nerdding-v2" });

  const mode = req.query.mode === "network" ? "network" : "for-you";
  const rows: Row[] = await postRows(mode, req.auth?.subjectId);
  const ids: string[] = rows.slice(0, 50).map((row: Row) => String(row.id));

  let states: Row[] = [];
  if (req.auth && ids.length) {
    const state = await db.execute(sql`SELECT p.id,
      EXISTS(SELECT 1 FROM post_likes x WHERE x.post_id=p.id AND x.user_id=${req.auth.subjectId}) AS viewer_liked,
      EXISTS(SELECT 1 FROM post_saves x WHERE x.post_id=p.id AND x.user_id=${req.auth.subjectId}) AS viewer_saved,
      EXISTS(SELECT 1 FROM post_reposts x WHERE x.post_id=p.id AND x.user_id=${req.auth.subjectId}) AS viewer_reposted
      FROM posts p WHERE p.id IN (${sql.join(ids.map((id) => sql`${id}`), sql`,`)})`);
    states = state as unknown as Row[];
  }

  const stateMap = new Map<string, Row>(states.map((state: Row) => [String(state.id), state]));
  const data = rows.slice(0, 50).map((row: Row) => {
    const state = stateMap.get(String(row.id));
    return serializePost(state ? { ...row, ...state } : row);
  });

  return res.json({
    data,
    algorithm: "nerdding-v2-transparent-interest-score",
    mode,
  });
});

async function loadComments(postId: string): Promise<CommentNode[]> {
  if (!db) return [];

  const result = await db.execute(sql`SELECT c.id, c.post_id, c.parent_id, c.body, c.created_at,
    u.id AS author_id, u.name, u.username, u.avatar_url
    FROM post_comments c
    JOIN users u ON u.id = c.author_id
    WHERE c.post_id=${postId}
    ORDER BY c.created_at ASC`);

  const rows = result as unknown as Row[];
  const byParent = new Map<string | null, CommentNode[]>();

  for (const row of rows) {
    const item: CommentNode = {
      id: String(row.id),
      postId: String(row.post_id),
      parentId: row.parent_id == null ? null : String(row.parent_id),
      body: String(row.body),
      createdAt: String(row.created_at),
      author: {
        id: row.author_id,
        name: row.name,
        username: row.username,
        avatarUrl: row.avatar_url,
      },
      replies: [],
    };

    const key = item.parentId;
    const list = byParent.get(key) ?? [];
    list.push(item);
    byParent.set(key, list);
  }

  const attach = (items: CommentNode[]): CommentNode[] =>
    items.map((item: CommentNode): CommentNode => ({
      ...item,
      replies: attach(byParent.get(item.id) ?? []),
    }));

  return attach(byParent.get(null) ?? []);
}

socialFeedRouter.get("/posts/:postId", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Post not found" });

  const [post] = (await db.execute(sql`SELECT p.*, u.name, u.username, u.avatar_url, u.account_type, u.bio, u.location, u.trust_score,
      (SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,
      (SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,
      (SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,
      (SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves,
      pr.name project_name, pr.slug project_slug, pr.stage project_stage, pr.description project_description, pr.github_url,
      p.project_id, p.quote_post_id
      FROM posts p
      JOIN users u ON u.id=p.author_id
      LEFT JOIN projects pr ON pr.id=p.project_id
      WHERE p.id=${req.params.postId}`) as unknown as Row[]);

  if (!post) return res.status(404).json({ error: "Post not found" });
  return res.json({ data: { ...serializePost(post), commentsTree: await loadComments(String(req.params.postId)) } });
});

socialFeedRouter.post("/posts/:postId/comments", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  const parsed = z.object({
    body: z.string().trim().min(1).max(2000),
    parentId: z.string().uuid().nullable().optional(),
  }).safeParse(req.body);

  if (!parsed.success) return res.status(400).json({ error: "Comment cannot be empty." });

  const [row] = (await db.execute(sql`INSERT INTO post_comments
    (id, post_id, author_id, parent_id, body)
    VALUES (gen_random_uuid(), ${req.params.postId}, ${req.auth!.subjectId}, ${parsed.data.parentId ?? null}, ${parsed.data.body})
    RETURNING id, post_id, parent_id, body, created_at`) as unknown as Row[]);

  const [author] = (await db.execute(sql`SELECT id, name, username, avatar_url FROM users WHERE id=${req.auth!.subjectId}`) as unknown as Row[]);
  return res.status(201).json({ data: { ...row, author } });
});

socialFeedRouter.post("/posts/:postId/quote", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  const parsed = z.object({ body: z.string().trim().max(5000).default("") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid quote." });

  const [row] = (await db.execute(sql`INSERT INTO posts
    (id, author_id, body, quote_post_id)
    VALUES (gen_random_uuid(), ${req.auth!.subjectId}, ${parsed.data.body}, ${req.params.postId})
    RETURNING id, body, created_at`) as unknown as Row[]);

  return res.status(201).json({ data: row });
});

socialFeedRouter.get("/users/:username/profile", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Profile not found" });

  const [user] = (await db.execute(sql`SELECT id,name,username,email,avatar_url,bio,location,account_type,interests,trust_score,created_at
    FROM users WHERE lower(username)=lower(${req.params.username}) LIMIT 1`) as unknown as Row[]);

  if (!user) return res.status(404).json({ error: "Profile not found" });

  const [counts] = (await db.execute(sql`SELECT
    (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,
    (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,
    (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,
    (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts`) as unknown as Row[]);

  const projects = await db.execute(sql`SELECT id,name,slug,description,stage,github_url,created_at
    FROM projects WHERE owner_id=${user.id} ORDER BY created_at DESC LIMIT 24`);
  const followers = await db.execute(sql`SELECT u.id,u.name,u.username,u.avatar_url
    FROM follows f JOIN users u ON u.id=f.follower_id
    WHERE f.following_id=${user.id} ORDER BY f.created_at DESC LIMIT 8`);
  const following = await db.execute(sql`SELECT u.id,u.name,u.username,u.avatar_url
    FROM follows f JOIN users u ON u.id=f.following_id
    WHERE f.follower_id=${user.id} ORDER BY f.created_at DESC LIMIT 8`);
  const viewerFollowing = req.auth
    ? await db.execute(sql`SELECT 1 FROM follows WHERE follower_id=${req.auth.subjectId} AND following_id=${user.id} LIMIT 1`)
    : [];
  const mutuals = req.auth
    ? await db.execute(sql`SELECT u.id,u.name,u.username,u.avatar_url
      FROM follows a JOIN follows b ON b.following_id=a.following_id JOIN users u ON u.id=a.following_id
      WHERE a.follower_id=${req.auth.subjectId} AND b.follower_id=${user.id} LIMIT 6`)
    : [];

  return res.json({
    data: {
      user: { ...user, avatarUrl: user.avatar_url },
      stats: counts,
      isFollowing: Array.isArray(viewerFollowing) ? viewerFollowing.length > 0 : false,
      projects,
      followers,
      following,
      mutualFollowers: mutuals,
    },
  });
});

socialFeedRouter.get("/users/:userId/followers", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const rows = await db.execute(sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type
    FROM follows f JOIN users u ON u.id=f.follower_id
    WHERE f.following_id=${req.params.userId} ORDER BY f.created_at DESC`);
  return res.json({ data: rows });
});

socialFeedRouter.get("/users/:userId/following", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const rows = await db.execute(sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type
    FROM follows f JOIN users u ON u.id=f.following_id
    WHERE f.follower_id=${req.params.userId} ORDER BY f.created_at DESC`);
  return res.json({ data: rows });
});

socialFeedRouter.get("/explore/live", async (_req, res) => {
  const rows: Row[] = await postRows("for-you");
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
      stories: rows.slice(0, 30).map((row: Row) => serializePost(row)),
      topics: [...topics.values()].sort((a, b) => b.engagement - a.engagement).slice(0, 12),
    },
    algorithm: "velocity-recency-quality-v2",
  });
});

socialFeedRouter.get("/charts/live", async (_req, res) => {
  if (!db) return res.json({ data: { risingBuilders: [], topProjects: [], trendingStartups: [], activeCommunities: [] } });

  const builders = await db.execute(sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type,u.trust_score,
      COUNT(DISTINCT p.id)::int posts,
      COUNT(DISTINCT pl.post_id)::int likes_received,
      COUNT(DISTINCT pc.id)::int replies_received,
      COUNT(DISTINCT f.follower_id)::int followers
    FROM users u
    LEFT JOIN posts p ON p.author_id=u.id
    LEFT JOIN post_likes pl ON pl.post_id=p.id
    LEFT JOIN post_comments pc ON pc.post_id=p.id
    LEFT JOIN follows f ON f.following_id=u.id
    GROUP BY u.id
    ORDER BY (COUNT(DISTINCT p.id)*3 + COUNT(DISTINCT pl.post_id)*2 + COUNT(DISTINCT pc.id)*3 + COUNT(DISTINCT f.follower_id)*0.2 + u.trust_score) DESC
    LIMIT 20`);

  const projects = await db.execute(sql`SELECT p.id,p.name,p.slug,p.description,p.stage,p.github_url,
      COUNT(DISTINCT ps.user_id)::int saves,
      COUNT(DISTINCT po.user_id)::int reposts
    FROM projects p
    LEFT JOIN posts x ON x.project_id=p.id
    LEFT JOIN post_saves ps ON ps.post_id=x.id
    LEFT JOIN post_reposts po ON po.post_id=x.id
    GROUP BY p.id
    ORDER BY saves DESC, reposts DESC
    LIMIT 12`);

  return res.json({
    data: { risingBuilders: builders, topProjects: projects, trendingStartups: [], activeCommunities: [] },
    algorithm: "proof-collaboration-consistency-v2",
  });
});

socialFeedRouter.get("/projects/:slug/github-commits", async (req, res) => {
  if (!db) return res.json({ data: [] });

  const [project] = (await db.execute(sql`SELECT github_url FROM projects WHERE slug=${req.params.slug} LIMIT 1`) as unknown as Row[]);
  const githubUrl = typeof project?.github_url === "string" ? project.github_url : "";
  if (!githubUrl) return res.json({ data: [] });

  try {
    const parsed = new URL(githubUrl);
    if (parsed.hostname.toLowerCase() !== "github.com") return res.json({ data: [] });

    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return res.json({ data: [] });

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/, "");
    const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?per_page=12`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "Nerddings/1.0",
      },
    });

    if (!response.ok) return res.json({ data: [] });

    const commits = await response.json() as any[];
    return res.json({
      data: commits.map((commit) => ({
        sha: commit.sha,
        message: commit.commit?.message?.split("\n")[0] ?? "Commit",
        author: commit.author?.login ?? commit.commit?.author?.name ?? "Unknown",
        avatarUrl: commit.author?.avatar_url ?? null,
        date: commit.commit?.author?.date,
        url: commit.html_url,
      })),
    });
  } catch {
    return res.json({ data: [] });
  }
});
