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
        (SELECT COUNT(DISTINCT p.id)::int
          FROM projects p
          LEFT JOIN project_collaborators pc
            ON pc.project_id=p.id
            AND pc.user_id=${user.id}
            AND pc.status='accepted'
          WHERE p.owner_id=${user.id} OR pc.user_id IS NOT NULL) projects,
        (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts
    `) as unknown as Row[])[0] ?? { followers: 0, following: 0, projects: 0, posts: 0 };

    // The current projects schema does not define github_url, so don't select it here.
    const projects = await db.execute(sql`
      SELECT DISTINCT p.id,p.name,p.slug,p.description,p.stage,p.created_at
      FROM projects p
      LEFT JOIN project_collaborators pc
        ON pc.project_id=p.id
        AND pc.user_id=${user.id}
        AND pc.status='accepted'
      WHERE p.owner_id=${user.id} OR pc.user_id IS NOT NULL
      ORDER BY p.created_at DESC
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
