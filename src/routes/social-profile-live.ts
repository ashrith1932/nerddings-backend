import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialProfileLiveRouter = Router();
type Row = Record<string, any>;
const rows = async (query: any): Promise<Row[]> => {
  const result = await db!.execute(query) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
};

socialProfileLiveRouter.get("/users/:username/profile-live", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Profile not found" });

  try {
    const [user] = await rows(sql`
      SELECT id,name,username,avatar_url,bio,location,account_type,interests,trust_score,created_at
      FROM users
      WHERE lower(username)=lower(${req.params.username})
      LIMIT 1
    `);
    if (!user) return res.status(404).json({ error: "Profile not found" });

    let profileMedia: Row = {};
    try {
      const [media] = await rows(sql`SELECT cover_url,profile_logo_url,cover_position_x,cover_position_y FROM users WHERE id=${user.id} LIMIT 1`);
      profileMedia = media ?? {};
    } catch {
      // Older production databases may not have the optional profile-media columns yet.
    }

    let stats: Row = { followers: 0, following: 0, projects: 0, posts: 0 };
    try {
      const [result] = await rows(sql`
        SELECT
          (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,
          (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,
          (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id} OR id IN (SELECT project_id FROM project_collaborators WHERE user_id=${user.id} AND status='accepted')) projects,
          (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts
      `);
      stats = result ?? stats;
    } catch {
      try {
        const [result] = await rows(sql`
          SELECT
            (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,
            (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,
            (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,
            (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts
        `);
        stats = result ?? stats;
      } catch {
        // Return zeroed stats instead of failing the whole profile.
      }
    }

    let projects: Row[] = [];
    try {
      projects = await rows(sql`
        SELECT id,name,slug,description,stage,github_url,created_at
        FROM projects
        WHERE owner_id=${user.id}
           OR id IN (SELECT project_id FROM project_collaborators WHERE user_id=${user.id} AND status='accepted')
        ORDER BY created_at DESC
        LIMIT 24
      `);
    } catch {
      projects = await rows(sql`
        SELECT id,name,slug,description,stage,github_url,created_at
        FROM projects WHERE owner_id=${user.id}
        ORDER BY created_at DESC LIMIT 24
      `);
    }

    let posts: Row[] = [];
    try {
      posts = await rows(sql`
        SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.quote_post_id,
          COUNT(DISTINCT pl.user_id)::int likes,
          COUNT(DISTINCT pc.id)::int comments,
          COUNT(DISTINCT pr.user_id)::int reposts,
          COUNT(DISTINCT ps.user_id)::int saves
        FROM posts p
        LEFT JOIN post_likes pl ON pl.post_id=p.id
        LEFT JOIN post_comments pc ON pc.post_id=p.id
        LEFT JOIN post_reposts pr ON pr.post_id=p.id
        LEFT JOIN post_saves ps ON ps.post_id=p.id
        WHERE p.author_id=${user.id}
        GROUP BY p.id
        ORDER BY p.created_at DESC
        LIMIT 50
      `);
    } catch {
      posts = [];
    }

    let affiliations: Row[] = [];
    try {
      affiliations = await rows(sql`
        SELECT a.id,a.name,a.slug,a.type,a.website,a.verified,aa.role
        FROM agent_affiliations aa
        JOIN agents a ON a.id=aa.agent_id
        WHERE aa.user_id=${user.id}
        ORDER BY aa.verified_at DESC
      `);
    } catch {
      affiliations = [];
    }

    return res.json({
      data: {
        user: {
          ...user,
          ...profileMedia,
          avatarUrl: user.avatar_url,
          coverUrl: profileMedia.cover_url ?? null,
          profileLogoUrl: profileMedia.profile_logo_url ?? null,
          coverPositionX: Number(profileMedia.cover_position_x ?? 50),
          coverPositionY: Number(profileMedia.cover_position_y ?? 50),
        },
        stats: {
          followers: Number(stats.followers ?? 0),
          following: Number(stats.following ?? 0),
          projects: Number(stats.projects ?? projects.length),
          posts: Number(stats.posts ?? posts.length),
        },
        projects,
        posts: posts.map((p) => ({
          id: p.id,
          authorId: p.author_id,
          text: p.body,
          createdAt: p.created_at,
          projectId: p.project_id,
          quotePostId: p.quote_post_id,
          likes: Number(p.likes ?? 0),
          comments: Number(p.comments ?? 0),
          reposts: Number(p.reposts ?? 0),
          saves: Number(p.saves ?? 0),
        })),
        affiliations: affiliations.map((a) => ({
          id: a.id,
          name: a.name,
          slug: a.slug,
          type: a.type,
          website: a.website,
          verified: Boolean(a.verified),
          role: a.role,
          status: "accepted",
        })),
      },
    });
  } catch (error) {
    console.error("[SocialProfileLive] Failed to load profile:", error);
    return res.status(500).json({ error: "Unable to load profile" });
  }
});
