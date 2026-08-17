import { Router } from "express";
import { sql } from "drizzle-orm";
import { exploreStories } from "../lib/store.js";
import { rankExplore, scoreTopChart } from "../lib/ranking.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { desc } from "drizzle-orm";

export const discoveryRouter = Router();

discoveryRouter.get("/explore", (_req, res) => {
  res.json({ data: rankExplore(exploreStories), algorithm: "meaningful-velocity-v1" });
});

discoveryRouter.get("/charts", async (_req, res) => {
  if (!db) return res.json({ data: { risingBuilders: [], topProjects: [], trendingStartups: [], activeCommunities: [] }, algorithm: "proof-and-collaboration-v1" });
  try {
    const rows = await db.select({ id: users.id, name: users.name, username: users.username, avatarUrl: users.avatarUrl, trustScore: users.trustScore, accountType: users.accountType }).from(users).orderBy(desc(users.trustScore)).limit(20);
    return res.json({ data: { risingBuilders: rows.map((user) => ({ ...user, score: scoreTopChart({ proofOfWork: user.trustScore / 100, meaningfulEngagement: user.trustScore / 100, consistency: user.trustScore / 100, collaboration: user.trustScore / 100, projectVisits: user.trustScore / 100, followers: 0, spamPenalty: 0 }) })), topProjects: [], trendingStartups: [], activeCommunities: [] }, algorithm: "proof-and-collaboration-v1" });
  } catch (error) {
    console.error("[Discovery] Charts failed:", error);
    return res.status(500).json({ error: "Charts are temporarily unavailable." });
  }
});

discoveryRouter.get("/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query) return res.json({ data: { users: [], projects: [], posts: [] } });
  if (!db) return res.json({ data: { users: [], projects: [], posts: [] } });
  try {
    const pattern = `%${query}%`;
    const userRows = await db.execute(sql`
      SELECT id,name,username,avatar_url,account_type
      FROM users
      WHERE name ILIKE ${pattern} OR username ILIKE ${pattern}
      ORDER BY trust_score DESC, created_at DESC
      LIMIT 20
    `) as unknown as Array<Record<string, any>>;
    const projectRows = await db.execute(sql`
      SELECT id,name,slug,description,stage
      FROM projects
      WHERE name ILIKE ${pattern} OR slug ILIKE ${pattern} OR description ILIKE ${pattern}
      ORDER BY created_at DESC
      LIMIT 20
    `) as unknown as Array<Record<string, any>>;
    const postRows = await db.execute(sql`
      SELECT p.id,p.body,p.created_at,u.name,u.username,u.avatar_url
      FROM posts p JOIN users u ON u.id=p.author_id
      WHERE p.body ILIKE ${pattern}
      ORDER BY p.created_at DESC
      LIMIT 20
    `) as unknown as Array<Record<string, any>>;
    return res.json({ data: {
      users: userRows.map((row) => ({ id: row.id, name: row.name, username: row.username, avatarUrl: row.avatar_url, accountType: row.account_type })),
      projects: projectRows.map((row) => ({ id: row.id, name: row.name, slug: row.slug, description: row.description, stage: row.stage })),
      posts: postRows.map((row) => ({ id: row.id, body: row.body, createdAt: row.created_at, name: row.name, username: row.username, avatarUrl: row.avatar_url })),
    } });
  } catch (error) {
    console.error("[Discovery] Search failed:", error);
    return res.status(500).json({ error: "Search is temporarily unavailable." });
  }
});
