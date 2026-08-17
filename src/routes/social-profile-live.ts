import { Router } from "express";
import { sql, eq, ilike } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

export const socialProfileLiveRouter = Router();
type Row = Record<string, any>;

async function executeRows(query: any): Promise<Row[]> {
  const result = await db!.execute(query) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
}

socialProfileLiveRouter.get("/users/:username/profile-live", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Profile not found" });

  try {
    const username = String(req.params.username);
    const [user] = await db.select({
      id: users.id,
      name: users.name,
      username: users.username,
      email: users.email,
      avatarUrl: users.avatarUrl,
      bio: users.bio,
      location: users.location,
      accountType: users.accountType,
      interests: users.interests,
      trustScore: users.trustScore,
      createdAt: users.createdAt,
    }).from(users).where(ilike(users.username, username)).limit(1);

    if (!user) return res.status(404).json({ error: "Profile not found" });

    let media: Row = {};
    try {
      const [row] = await executeRows(sql`SELECT cover_url,profile_logo_url,cover_position_x,cover_position_y FROM users WHERE id=${user.id} LIMIT 1`);
      media = row ?? {};
    } catch (error) {
      console.warn("[SocialProfileLive] Optional profile media unavailable:", error);
    }

    let stats = { followers: 0, following: 0, projects: 0, posts: 0 };
    try {
      const [row] = await executeRows(sql`
        SELECT
          (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) AS followers,
          (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) AS following,
          (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) AS projects,
          (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) AS posts
      `);
      if (row) stats = { followers: Number(row.followers ?? 0), following: Number(row.following ?? 0), projects: Number(row.projects ?? 0), posts: Number(row.posts ?? 0) };
    } catch (error) {
      console.warn("[SocialProfileLive] Stats query failed:", error);
    }

    let projects: Row[] = [];
    try {
      projects = await executeRows(sql`
        SELECT id,name,slug,description,stage,github_url,created_at
        FROM projects WHERE owner_id=${user.id}
        ORDER BY created_at DESC LIMIT 24
      `);
    } catch (error) {
      console.warn("[SocialProfileLive] Projects query failed:", error);
    }

    let posts: Row[] = [];
    try {
      posts = await executeRows(sql`
        SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.quote_post_id,
          (SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,
          (SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,
          (SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,
          (SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves
        FROM posts p WHERE p.author_id=${user.id}
        ORDER BY p.created_at DESC LIMIT 50
      `);
    } catch (error) {
      console.warn("[SocialProfileLive] Posts query failed:", error);
    }

    let affiliations: Row[] = [];
    try {
      affiliations = await executeRows(sql`
        SELECT a.id,a.name,a.slug,a.type,a.website,a.verified,aa.role
        FROM agent_affiliations aa
        JOIN agents a ON a.id=aa.agent_id
        WHERE aa.user_id=${user.id}
        ORDER BY aa.verified_at DESC
      `);
    } catch (error) {
      console.warn("[SocialProfileLive] Affiliations query failed:", error);
    }

    return res.json({ data: {
      user: {
        ...user,
        avatarUrl: user.avatarUrl,
        coverUrl: media.cover_url ?? null,
        profileLogoUrl: media.profile_logo_url ?? null,
        coverPositionX: Number(media.cover_position_x ?? 50),
        coverPositionY: Number(media.cover_position_y ?? 50),
      },
      stats,
      projects,
      posts: posts.map((post) => ({
        id: post.id,
        authorId: post.author_id,
        text: post.body,
        createdAt: post.created_at,
        projectId: post.project_id,
        quotePostId: post.quote_post_id,
        likes: Number(post.likes ?? 0),
        comments: Number(post.comments ?? 0),
        reposts: Number(post.reposts ?? 0),
        saves: Number(post.saves ?? 0),
      })),
      affiliations: affiliations.map((item) => ({
        id: item.id,
        name: item.name,
        slug: item.slug,
        type: item.type,
        website: item.website,
        verified: Boolean(item.verified),
        role: item.role,
        status: "accepted",
      })),
    } });
  } catch (error) {
    console.error("[SocialProfileLive] Failed to load profile:", error);
    return res.status(500).json({ error: "Unable to load profile" });
  }
});
