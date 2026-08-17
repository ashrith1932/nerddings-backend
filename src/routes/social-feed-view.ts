import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialFeedViewRouter = Router();
type Row = Record<string, any>;
const clamp = (v:number,min=0,max=1)=>Math.max(min,Math.min(max,v));
const score=(r:Row)=>{
  const age=Math.max(.1,(Date.now()-new Date(r.created_at).getTime())/36e5);
  const fresh=1/Math.pow(1+age/8,.65);
  const eng=Math.log1p(Number(r.likes)+Number(r.comments)*2+Number(r.reposts)*2.5+Number(r.saves))/10;
  return fresh*.28+eng*.2+clamp(Number(r.proof_of_work_score)/2)*.16+clamp(Number(r.trust_score)/100)*.12+(r.is_following?1:0)*.1+clamp(Number(r.meaningful_engagement_score)/2)*.14-clamp(Number(r.spam_penalty)/2)*.2;
};

socialFeedViewRouter.get("/feed", async (req,res)=>{
  if(!db) return res.json({data:[],algorithm:"nerdding-v2"});
  const mode=req.query.mode==="network"?"network":"for-you";
  const viewer=req.auth?.subjectId;
  const network=mode==="network"&&viewer?sql`AND (p.author_id=${viewer} OR EXISTS(SELECT 1 FROM follows f2 WHERE f2.follower_id=${viewer} AND f2.following_id=p.author_id))`:sql``;
  const viewerJoin=viewer?sql`LEFT JOIN follows vf ON vf.follower_id=${viewer} AND vf.following_id=p.author_id`:sql``;
  const rows=await db.execute(sql`
    SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.quote_post_id,p.link_url,p.proof_of_work_score,p.meaningful_engagement_score,p.spam_penalty,
      u.name,u.username,u.avatar_url,u.account_type,u.bio,u.location,u.trust_score,
      pr.name AS project_name,pr.slug AS project_slug,pr.stage AS project_stage,pr.description AS project_description,pr.github_url,
      COUNT(DISTINCT pl.user_id)::int likes,COUNT(DISTINCT pc.id)::int comments,COUNT(DISTINCT rr.user_id)::int reposts,COUNT(DISTINCT ps.user_id)::int saves,
      BOOL_OR(vf.follower_id IS NOT NULL) is_following,
      COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media
    FROM posts p JOIN users u ON u.id=p.author_id
    LEFT JOIN projects pr ON pr.id=p.project_id LEFT JOIN post_likes pl ON pl.post_id=p.id LEFT JOIN post_comments pc ON pc.post_id=p.id
    LEFT JOIN post_reposts rr ON rr.post_id=p.id LEFT JOIN post_saves ps ON ps.post_id=p.id ${viewerJoin}
    WHERE 1=1 ${network} GROUP BY p.id,u.id,pr.id ORDER BY p.created_at DESC LIMIT 160` ) as unknown as Row[];
  const ranked=rows.map((r)=>({...r,score:score(r)})).sort((a,b)=>Number(b.score)-Number(a.score)).slice(0,50);
  let states:Row[]=[];
  if(viewer&&ranked.length){const ids=ranked.map((r)=>String(r.id));states=await db.execute(sql`SELECT p.id,EXISTS(SELECT 1 FROM post_likes x WHERE x.post_id=p.id AND x.user_id=${viewer}) viewer_liked,EXISTS(SELECT 1 FROM post_saves x WHERE x.post_id=p.id AND x.user_id=${viewer}) viewer_saved,EXISTS(SELECT 1 FROM post_reposts x WHERE x.post_id=p.id AND x.user_id=${viewer}) viewer_reposted FROM posts p WHERE p.id IN (${sql.join(ids.map((id)=>sql`${id}`),sql`,`)})`) as unknown as Row[];}
  const stateMap=new Map(states.map((s)=>[String(s.id),s]));
  const data=ranked.map((r)=>{const s=stateMap.get(String(r.id))||{};return {id:r.id,authorId:r.author_id,author:{id:r.author_id,name:r.name,username:r.username,avatarUrl:r.avatar_url,accountType:r.account_type,bio:r.bio,location:r.location},text:r.body,createdAt:r.created_at,score:Math.round(Number(r.score)*1000)/1000,likes:Number(r.likes||0),comments:Number(r.comments||0),reposts:Number(r.reposts||0),saves:Number(r.saves||0),liked:Boolean(s.viewer_liked),saved:Boolean(s.viewer_saved),reposted:Boolean(s.viewer_reposted),following:Boolean(r.is_following),linkUrl:r.link_url||null,media:r.media||[],project:r.project_id?{id:r.project_id,name:r.project_name,slug:r.project_slug,stage:r.project_stage,description:r.project_description,githubUrl:r.github_url}:null,quotePostId:r.quote_post_id||null};});
  res.json({data,algorithm:"nerdding-v3-transparent-interest-score",mode});
});
