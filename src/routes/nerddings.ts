import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { follows, postMedia, postSaves, posts, users } from "../db/schema.js";
import { desc, eq, inArray } from "drizzle-orm";

import { sql } from "drizzle-orm";
import { serialize } from "./social-feed-stable.js";

export const nerddingsRouter = Router();

nerddingsRouter.get("/", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: { savedPosts: [], following: [], stats: { following: 0, savedPosts: 0, collaborations: 0, affiliations: 0 } } });

  const viewerId = req.auth!.subjectId;

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
      EXISTS(SELECT 1 FROM post_likes vl WHERE vl.post_id=p.id AND vl.user_id=${viewerId}) viewer_liked,
      true AS viewer_saved,
      EXISTS(SELECT 1 FROM post_reposts vr WHERE vr.post_id=p.id AND vr.user_id=${viewerId}) viewer_reposted,
      COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media,
      COALESCE((SELECT json_agg(h.tag ORDER BY h.tag) FROM post_hashtags ph JOIN hashtags h ON h.id=ph.hashtag_id WHERE ph.post_id=p.id),'[]'::json) hashtags,
      (SELECT json_build_object(
        'id',qp.id,
        'text',qp.body,
        'createdAt',qp.created_at,
        'linkUrl',qp.link_url,
        'author',json_build_object('id',qu.id,'name',qu.name,'username',qu.username,'avatarUrl',qu.avatar_url,'accountType',qu.account_type),
        'project',CASE WHEN qpr.id IS NULL THEN NULL ELSE json_build_object('id',qpr.id,'name',qpr.name,'slug',qpr.slug,'stage',qpr.stage,'description',qpr.description,'githubUrl',qpr.github_url) END,
        'media',COALESCE((SELECT json_agg(json_build_object('publicUrl',qpm.public_url,'mimeType',qpm.mime_type) ORDER BY qpm.sort_order) FROM post_media qpm WHERE qpm.post_id=qp.id),'[]'::json),
        'likes',(SELECT COUNT(*)::int FROM post_likes ql WHERE ql.post_id=qp.id),
        'comments',(SELECT COUNT(*)::int FROM post_comments qc WHERE qc.post_id=qp.id),
        'reposts',(SELECT COUNT(*)::int FROM post_reposts qr WHERE qr.post_id=qp.id),
        'saves',(SELECT COUNT(*)::int FROM post_saves qs WHERE qs.post_id=qp.id),
        'views',(SELECT COUNT(*)::int FROM post_views qv WHERE qv.post_id=qp.id)
      ) FROM posts qp JOIN users qu ON qu.id=qp.author_id LEFT JOIN projects qpr ON qpr.id=qp.project_id WHERE qp.id=p.quote_post_id) quote_post
    FROM post_saves target
    JOIN posts p ON p.id = target.post_id
    JOIN users u ON u.id = p.author_id
    LEFT JOIN projects pr ON pr.id=p.project_id
    LEFT JOIN post_likes pl ON pl.post_id=p.id LEFT JOIN post_comments pc ON pc.post_id=p.id
    LEFT JOIN post_reposts rr ON rr.post_id=p.id LEFT JOIN post_saves ps ON ps.post_id=p.id
    LEFT JOIN follows vf ON vf.follower_id=${viewerId} AND vf.following_id=p.author_id
    WHERE target.user_id = ${viewerId}
    GROUP BY p.id,u.id,pr.id,target.created_at ORDER BY target.created_at DESC LIMIT 50
  `);

  const followingRows = await db.select({ user: users }).from(follows).innerJoin(users, eq(follows.followingId, users.id)).where(eq(follows.followerId, req.auth!.subjectId)).orderBy(desc(follows.createdAt)).limit(50);
  
  const rawRows = Array.isArray(result) ? result : (result as any).rows ?? [];

  return res.json({ 
    data: { 
      savedPosts: rawRows.map(serialize), 
      following: followingRows.map(({ user }) => ({ id: user.id, name: user.name, username: user.username, accountType: user.accountType, avatarUrl: user.avatarUrl })), 
      stats: { following: followingRows.length, savedPosts: rawRows.length, collaborations: 0, affiliations: 0 } 
    } 
  });
});

