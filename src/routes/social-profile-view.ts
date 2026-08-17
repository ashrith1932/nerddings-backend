import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialProfileViewRouter = Router();
type Row = Record<string, any>;

socialProfileViewRouter.get("/users/:username/profile", async (req, res) => {
  if (!db) return res.status(503).json({ error: "Profile service is unavailable" });

  const username = String(req.params.username ?? "").trim();
  if (!username) return res.status(400).json({ error: "Username is required" });

  try {
    const users = await db.execute(sql`
      SELECT id,name,username,email,avatar_url,bio,location,account_type,interests,trust_score,created_at
      FROM users
      WHERE lower(username)=lower(${username})
      LIMIT 1
    `) as unknown as Row[];

    const user = users[0];
    if (!user) return res.status(404).json({ error: "Profile not found" });

    const counts = (await db.execute(sql`
      SELECT
        (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,
        (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,
        (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,
        (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts
    `) as unknown as Row[])[0] ?? { followers: 0, following: 0, projects: 0, posts: 0 };

    // The canonical projects schema currently supports ownership, not collaborators.
    const projects = await db.execute(sql`
      SELECT id,name,slug,description,stage,created_at
      FROM projects
      WHERE owner_id=${user.id}
      ORDER BY created_at DESC
      LIMIT 24
    `) as unknown as Row[];

    const followers = await db.execute(sql`
      SELECT u.id,u.name,u.username,u.avatar_url
      FROM follows f JOIN users u ON u.id=f.follower_id
      WHERE f.following_id=${user.id}
      ORDER BY f.created_at DESC LIMIT 12
    `) as unknown as Row[];

    const following = await db.execute(sql`
      SELECT u.id,u.name,u.username,u.avatar_url
      FROM follows f JOIN users u ON u.id=f.following_id
      WHERE f.follower_id=${user.id}
      ORDER BY f.created_at DESC LIMIT 12
    `) as unknown as Row[];

    const viewer = req.auth?.subjectId;
    const viewerFollowing = viewer
      ? await db.execute(sql`
          SELECT 1 FROM follows
          WHERE follower_id=${viewer} AND following_id=${user.id}
          LIMIT 1
        `)
      : [];

    const mutualFollowers = viewer
      ? await db.execute(sql`
          SELECT DISTINCT u.id,u.name,u.username,u.avatar_url
          FROM follows mine
          JOIN follows target ON target.following_id=mine.following_id
          JOIN users u ON u.id=mine.following_id
          WHERE mine.follower_id=${viewer}
            AND target.follower_id=${user.id}
          LIMIT 6
        `)
      : [];

    return res.json({
      data: {
        user,
        stats: counts,
        isFollowing: Array.isArray(viewerFollowing) && viewerFollowing.length > 0,
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
