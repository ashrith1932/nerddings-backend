import { Router } from "express";
import { sql, desc } from "drizzle-orm";
import { exploreStories } from "../lib/store.js";
import { rankExplore, scoreTopChart } from "../lib/ranking.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

export const discoveryRouter = Router();
discoveryRouter.get("/explore", (_req, res) => { res.json({ data: rankExplore(exploreStories), algorithm: "meaningful-velocity-v1" }); });

async function rows(query: any): Promise<Record<string, any>[]> { const result = await db!.execute(query) as unknown as { rows: Record<string, any>[] } | Record<string, any>[]; return Array.isArray(result) ? result : result.rows; }

// Real-time snapshot ranking. It intentionally favors recent meaningful activity, but keeps trust/proof signals so a short spike cannot dominate forever.
discoveryRouter.get("/charts", async (_req, res) => {
  if (!db) return res.json({ data: { risingBuilders: [], topProjects: [], trendingStartups: [], activeCommunities: [] }, algorithm: "realtime-proof-engagement-v2" });
  try {
    const builderRows = await rows(sql`
      SELECT u.id,u.name,u.username,u.avatar_url,u.trust_score,u.account_type,
        COALESCE((SELECT COUNT(*) FROM posts p WHERE p.author_id=u.id AND p.created_at>NOW()-INTERVAL '7 days'),0)::int posts_7d,
        COALESCE((SELECT COUNT(*) FROM post_likes l JOIN posts p ON p.id=l.post_id WHERE p.author_id=u.id AND l.created_at>NOW()-INTERVAL '7 days'),0)::int likes_7d,
        COALESCE((SELECT COUNT(*) FROM post_comments c JOIN posts p ON p.id=c.post_id WHERE p.author_id=u.id AND c.created_at>NOW()-INTERVAL '7 days'),0)::int comments_7d,
        COALESCE((SELECT COUNT(*) FROM post_reposts r JOIN posts p ON p.id=r.post_id WHERE p.author_id=u.id AND r.created_at>NOW()-INTERVAL '7 days'),0)::int reposts_7d,
        COALESCE((SELECT COUNT(*) FROM follows f WHERE f.following_id=u.id),0)::int followers
      FROM users u
      WHERE EXISTS(SELECT 1 FROM posts p WHERE p.author_id=u.id AND p.created_at>NOW()-INTERVAL '30 days')
      ORDER BY u.trust_score DESC LIMIT 100
    `);
    const risingBuilders=builderRows.map(user=>{
      const proof=Number(user.trust_score)/100; const engagement=Math.min(1,Math.log1p(Number(user.likes_7d)+Number(user.comments_7d)*2+Number(user.reposts_7d)*2.5)/8); const consistency=Math.min(1,Number(user.posts_7d)/20); const collaboration=Math.min(1,Number(user.comments_7d+user.reposts_7d)/25); const followers=Math.min(1,Math.log1p(Number(user.followers))/10); const score=scoreTopChart({proofOfWork:proof,meaningfulEngagement:engagement,consistency,collaboration,projectVisits:Math.min(1,Number(user.posts_7d)/15),followers,spamPenalty:0}); return {...user,avatarUrl:user.avatar_url,score};}).sort((a,b)=>b.score-a.score).slice(0,20);

    const projectRows=await rows(sql`
      SELECT pr.id,pr.name,pr.slug,pr.stage,pr.description,
        COUNT(DISTINCT p.id)::int posts_7d,
        COUNT(DISTINCT l.user_id)::int likes_7d,
        COUNT(DISTINCT c.id)::int comments_7d,
        COUNT(DISTINCT r.user_id)::int reposts_7d
      FROM projects pr JOIN posts p ON p.project_id=pr.id AND p.created_at>NOW()-INTERVAL '30 days'
      LEFT JOIN post_likes l ON l.post_id=p.id AND l.created_at>NOW()-INTERVAL '7 days'
      LEFT JOIN post_comments c ON c.post_id=p.id AND c.created_at>NOW()-INTERVAL '7 days'
      LEFT JOIN post_reposts r ON r.post_id=p.id AND r.created_at>NOW()-INTERVAL '7 days'
      GROUP BY pr.id ORDER BY (COUNT(DISTINCT l.user_id)+COUNT(DISTINCT c.id)*2+COUNT(DISTINCT r.user_id)*2.5) DESC LIMIT 20
    `);
    const topProjects=projectRows.map(project=>({id:project.id,name:project.name,slug:project.slug,stage:project.stage,description:project.description,score:Math.round((Math.log1p(Number(project.likes_7d)+Number(project.comments_7d)*2+Number(project.reposts_7d)*2.5)*0.6+Number(project.posts_7d)*0.4)*100)/100}));

    const startups=await rows(sql`SELECT id,startup_name,stage,industry,target_amount,raised_amount,currency,investor_count,created_at FROM fundraisings ORDER BY created_at DESC LIMIT 50`);
    const trendingStartups=startups.map(item=>{const target=Number(item.target_amount)||1;const raised=Number(item.raised_amount)||0;return {...item,startupName:item.startup_name,targetAmount:target,raisedAmount:raised,progress:Math.min(100,Math.round(raised/target*100)),score:Math.round((Math.min(1,raised/target)*0.55+Math.min(1,Number(item.investor_count)/100)*0.25+(Date.now()-new Date(item.created_at).getTime()<7*864e5?0.2:0))*100)/100};}).sort((a,b)=>b.score-a.score).slice(0,20);
    return res.json({data:{risingBuilders,topProjects,trendingStartups,activeCommunities:[]},algorithm:"realtime-proof-engagement-v2",generatedAt:new Date().toISOString()});
  } catch (error) { console.error("[Discovery] Charts failed:",error); return res.status(500).json({error:"Charts are temporarily unavailable."}); }
});

discoveryRouter.get("/search", async (req, res) => {
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (!query || !db) return res.json({ data: { users: [], projects: [], posts: [], hashtags: [] } });
  try {
    const tagQuery=query.replace(/^#/,'').toLowerCase(); const pattern=`%${query}%`;
    const [userRows, projectRows, postRows, hashtagRows] = await Promise.all([
      rows(sql`SELECT id,name,username,avatar_url,account_type FROM users WHERE name ILIKE ${pattern} OR username ILIKE ${pattern} ORDER BY trust_score DESC, created_at DESC LIMIT 20`),
      rows(sql`SELECT id,name,slug,description,stage FROM projects WHERE name ILIKE ${pattern} OR slug ILIKE ${pattern} OR description ILIKE ${pattern} ORDER BY created_at DESC LIMIT 20`),
      query.startsWith("#") ? rows(sql`SELECT p.id,p.body,p.created_at,u.name,u.username,u.avatar_url FROM posts p JOIN post_hashtags ph ON ph.post_id=p.id JOIN hashtags h ON h.id=ph.hashtag_id JOIN users u ON u.id=p.author_id WHERE h.tag=${tagQuery} ORDER BY p.created_at DESC LIMIT 20`) : rows(sql`SELECT p.id,p.body,p.created_at,u.name,u.username,u.avatar_url FROM posts p JOIN users u ON u.id=p.author_id WHERE p.body ILIKE ${pattern} ORDER BY p.created_at DESC LIMIT 20`),
      rows(sql`SELECT id,tag FROM hashtags WHERE tag ILIKE ${query.startsWith('#')?tagQuery+'%':pattern} ORDER BY tag LIMIT 20`),
    ]);
    return res.json({data:{users:userRows.map(row=>({id:row.id,name:row.name,username:row.username,avatarUrl:row.avatar_url,accountType:row.account_type})),projects:projectRows.map(row=>({id:row.id,name:row.name,slug:row.slug,description:row.description,stage:row.stage})),posts:postRows.map(row=>({id:row.id,body:row.body,createdAt:row.created_at,name:row.name,username:row.username,avatarUrl:row.avatar_url})),hashtags:hashtagRows.map(row=>({id:row.id,tag:row.tag}))}});
  } catch(error){console.error("[Discovery] Search failed:",error);return res.status(500).json({error:"Search is temporarily unavailable."});}
});
