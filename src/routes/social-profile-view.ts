import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialProfileViewRouter = Router();
type Row = Record<string, any>;

type QueryResultLike<T> = T[] | { rows: T[] };

async function executeRows<T extends Row>(query: any): Promise<T[]> {
  const result = await db!.execute(query) as unknown as QueryResultLike<T>;
  return Array.isArray(result) ? result : result.rows;
}

socialProfileViewRouter.get("/users/:username/profile", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Profile service is unavailable" });

  const username = String(req.params.username ?? "").trim();
  if (!username) return res.status(400).json({ error: "Username is required" });

  try {
    const users = await executeRows<Row>(sql`
      SELECT id,name,username,email,avatar_url,bio,location,account_type,interests,trust_score,created_at
      FROM users
      WHERE lower(username)=lower(${username})
      LIMIT 1
    `);

    const user = users[0];
    if (!user) return res.status(404).json({ error: "Profile not found" });

    const countRows = await executeRows<Row>(sql`
      SELECT
        (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) AS followers,
        (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) AS following,
        (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) AS projects,
        (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) AS posts
    `);
    const counts = countRows[0] ?? { followers: 0, following: 0, projects: 0, posts: 0 };

    // Keep this projection aligned with the actual projects table schema.
    // logo_url and website_url are not columns in db/schema.ts; requesting
    // them made every profile request fail with PostgreSQL 42703.
    const projects = await executeRows<Row>(sql`
      SELECT id,name,slug,description,stage,github_url,created_at
      FROM projects
      WHERE owner_id=${user.id}
      ORDER BY created_at DESC
      LIMIT 24
    `);

    const followers = await executeRows<Row>(sql`
      SELECT u.id,u.name,u.username,u.avatar_url,u.account_type
      FROM follows f
      JOIN users u ON u.id=f.follower_id
      WHERE f.following_id=${user.id}
      ORDER BY f.created_at DESC
      LIMIT 50
    `);

    const following = await executeRows<Row>(sql`
      SELECT u.id,u.name,u.username,u.avatar_url,u.account_type
      FROM follows f
      JOIN users u ON u.id=f.following_id
      WHERE f.follower_id=${user.id}
      ORDER BY f.created_at DESC
      LIMIT 50
    `);

    const viewer = req.auth?.subjectId;
    const viewerFollowing = viewer
      ? await executeRows<Row>(sql`
          SELECT 1
          FROM follows
          WHERE follower_id=${viewer}
            AND following_id=${user.id}
          LIMIT 1
        `)
      : [];

    const mutualFollowers = viewer && viewer !== user.id
      ? await executeRows<Row>(sql`
          SELECT DISTINCT u.id,u.name,u.username,u.avatar_url,u.account_type
          FROM follows mine
          JOIN follows target
            ON target.following_id=mine.following_id
          JOIN users u
            ON u.id=mine.following_id
          WHERE mine.follower_id=${viewer}
            AND target.follower_id=${user.id}
          LIMIT 6
        `)
      : [];

    return res.json({
      data: {
        user,
        stats: {
          followers: Number(counts.followers ?? 0),
          following: Number(counts.following ?? 0),
          projects: Number(counts.projects ?? 0),
          posts: Number(counts.posts ?? 0),
        },
        isFollowing: viewerFollowing.length > 0,
        projects,
        followers,
        following,
        mutualFollowers,
      },
    });
  } catch (error) {
    console.error("[SocialProfile] Failed to load profile:", error);
    return res.status(500).json({ error: "Unable to load profile" });
  }
});
