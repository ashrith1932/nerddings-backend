import { Router } from "express";
import { sql, ilike } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

type Row=Record<string,any>;
export const socialProfileLiveStableRouter=Router();
async function rows(query:any):Promise<Row[]>{const result=await db!.execute(query) as unknown as Row[]|{rows:Row[]};return Array.isArray(result)?result:result.rows;}

socialProfileLiveStableRouter.get("/users/:username/profile-live",async(req,res)=>{
  if(!db)return res.status(404).json({error:"Profile not found"});
  try{
    const [user]=await db.select({id:users.id,name:users.name,username:users.username,email:users.email,avatarUrl:users.avatarUrl,bio:users.bio,location:users.location,accountType:users.accountType,interests:users.interests,trustScore:users.trustScore,createdAt:users.createdAt}).from(users).where(ilike(users.username,String(req.params.username))).limit(1);
    if(!user)return res.status(404).json({error:"Profile not found"});
    let media:Row={};try{media=(await rows(sql`SELECT cover_url,profile_logo_url,cover_position_x,cover_position_y FROM users WHERE id=${user.id} LIMIT 1`))[0]??{};}catch{}
    let stats={followers:0,following:0,projects:0,posts:0};try{const r=(await rows(sql`SELECT (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,(SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,(SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,(SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts`))[0];if(r)stats={followers:Number(r.followers||0),following:Number(r.following||0),projects:Number(r.projects||0),posts:Number(r.posts||0)};}catch{}
    let projects:Row[]=[];try{projects=await rows(sql`SELECT id,name,slug,description,stage,github_url,created_at FROM projects WHERE owner_id=${user.id} OR EXISTS(SELECT 1 FROM project_collaborators pc WHERE pc.project_id=projects.id AND pc.user_id=${user.id} AND pc.status='accepted') ORDER BY created_at DESC LIMIT 50`);}catch{}
    let posts:Row[]=[];try{posts=await rows(sql`SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.agent_id,p.quote_post_id,pr.name project_name,pr.slug project_slug,a.name agent_name,a.slug agent_slug,(SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,(SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,(SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,(SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves FROM posts p LEFT JOIN projects pr ON pr.id=p.project_id LEFT JOIN agents a ON a.id=p.agent_id WHERE p.author_id=${user.id} ORDER BY p.created_at DESC LIMIT 100`);}catch{}
    let affiliations:Row[]=[];try{affiliations=await rows(sql`SELECT a.id,a.name,a.slug,a.type,a.website,a.verified,aa.role,aa.verified_at FROM agent_affiliations aa JOIN agents a ON a.id=aa.agent_id WHERE aa.user_id=${user.id} ORDER BY aa.verified_at DESC`);}catch{}
    let affiliationHistory:Row[]=[];try{affiliationHistory=await rows(sql`SELECT h.id,h.agent_id,h.role,h.event_type,h.created_at,a.name agent_name,a.slug agent_slug FROM agent_affiliation_history h JOIN agents a ON a.id=h.agent_id WHERE h.user_id=${user.id} ORDER BY h.created_at ASC`);}catch{}
    const historyByAgent=new Map<string,Row[]>();
    for(const h of affiliationHistory){const list=historyByAgent.get(String(h.agent_id))??[];list.push(h);historyByAgent.set(String(h.agent_id),list);}
    for(const a of affiliations){const key=String(a.id);if(!(historyByAgent.get(key)?.length)){historyByAgent.set(key,[{id:`initial-${a.id}`,agent_id:a.id,role:a.role,event_type:"affiliation",created_at:a.verified_at,agent_name:a.name,agent_slug:a.slug}]);}}
    const buildHistory=posts.filter(p=>p.project_id).sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime()).map(p=>({id:p.id,createdAt:p.created_at,postId:p.id,projectId:p.project_id,projectName:p.project_name,projectSlug:p.project_slug,text:p.body,authorId:p.author_id}));
    return res.json({data:{user:{...user,avatarUrl:user.avatarUrl,coverUrl:media.cover_url??null,profileLogoUrl:media.profile_logo_url??null,coverPositionX:Number(media.cover_position_x??50),coverPositionY:Number(media.cover_position_y??50)},stats,projects,posts:posts.map(p=>({id:p.id,authorId:p.author_id,text:p.body,createdAt:p.created_at,projectId:p.project_id,projectName:p.project_name,projectSlug:p.project_slug,agentId:p.agent_id,agentName:p.agent_name,agentSlug:p.agent_slug,quotePostId:p.quote_post_id,likes:Number(p.likes||0),comments:Number(p.comments||0),reposts:Number(p.reposts||0),saves:Number(p.saves||0)})),buildHistory,affiliations:affiliations.map(a=>({id:a.id,name:a.name,slug:a.slug,type:a.type,website:a.website,verified:Boolean(a.verified),role:a.role,status:"accepted",timeline:(historyByAgent.get(String(a.id))??[]).map(h=>({id:h.id,role:h.role,eventType:h.event_type,createdAt:h.created_at}))}))}});
  }catch(error){console.error("[SocialProfileLiveStable] Failed:",error);return res.status(500).json({error:"Unable to load profile"});}
});
