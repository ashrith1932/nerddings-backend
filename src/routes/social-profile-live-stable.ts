import { Router } from "express";
import { sql, ilike } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";

type Row=Record<string,any>;
export const socialProfileLiveStableRouter=Router();
async function rows(query:any):Promise<Row[]>{const result=await db!.execute(query) as unknown as Row[]|{rows:Row[]};return Array.isArray(result)?result:result.rows;}

async function profileUser(username:string){
  const result=await rows(sql`SELECT id,name,username,avatar_url,bio,account_type FROM users WHERE username ILIKE ${username} LIMIT 1`);
  return result[0]??null;
}

socialProfileLiveStableRouter.get("/users/:username/profile-summary",async(req,res)=>{
  if(!db)return res.status(404).json({error:"Profile not found"});
  try{
    const user=await profileUser(String(req.params.username));
    if(!user)return res.status(404).json({error:"Profile not found"});
    const stats=(await rows(sql`SELECT
      (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,
      (SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,
      (SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,
      (SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts`))[0]??{};
    const affiliations=await rows(sql`SELECT a.id,a.name,a.slug,a.type,a.verified,aa.role FROM agent_affiliations aa JOIN agents a ON a.id=aa.agent_id WHERE aa.user_id=${user.id} ORDER BY aa.verified_at DESC`);
    return res.json({data:{user:{id:user.id,name:user.name,username:user.username,avatarUrl:user.avatar_url??null,bio:user.bio??null,accountType:user.account_type},stats:{followers:Number(stats.followers||0),following:Number(stats.following||0),projects:Number(stats.projects||0),posts:Number(stats.posts||0)},affiliations:affiliations.map(a=>({id:a.id,name:a.name,slug:a.slug,type:a.type,verified:Boolean(a.verified),role:a.role}))}});
  }catch(error){console.error("[ProfileSummary] Failed:",error);return res.status(500).json({error:"Unable to load profile summary"});}
});

socialProfileLiveStableRouter.get("/users/:username/profile-items",async(req,res)=>{
  if(!db)return res.status(404).json({error:"Profile not found"});
  try{
    const user=await profileUser(String(req.params.username));
    if(!user)return res.status(404).json({error:"Profile not found"});
    const type=String(req.query.type||"posts");
    const limit=Math.min(Math.max(Number(req.query.limit||15),1),30);
    const cursorCreatedAt=req.query.cursorCreatedAt?new Date(String(req.query.cursorCreatedAt)):null;
    const cursorId=req.query.cursorId?String(req.query.cursorId):null;
    const q=String(req.query.q||"").trim();
    const search=q?`%${q}%`:null;
    let items:Row[]=[];
    const cursorPosts=cursorCreatedAt&&cursorId?sql`AND (p.created_at,p.id)<(${cursorCreatedAt},${cursorId})`:sql``;
    const cursorProjects=cursorCreatedAt&&cursorId?sql`AND (created_at,id)<(${cursorCreatedAt},${cursorId})`:sql``;
    const cursorPeople=cursorCreatedAt&&cursorId?sql`AND (f.created_at,u.id)<(${cursorCreatedAt},${cursorId})`:sql``;
    if(type==="posts") items=await rows(sql`SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.quote_post_id,p.link_url,pr.name project_name,pr.slug project_slug,(SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,(SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,(SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,(SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves,COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media,(SELECT json_build_object('id',qp.id,'authorId',qp.author_id,'text',qp.body,'createdAt',qp.created_at,'linkUrl',qp.link_url,'author',json_build_object('id',qu.id,'name',qu.name,'username',qu.username,'avatarUrl',qu.avatar_url,'accountType',qu.account_type),'media',COALESCE((SELECT json_agg(json_build_object('publicUrl',qpm.public_url,'mimeType',qpm.mime_type) ORDER BY qpm.sort_order) FROM post_media qpm WHERE qpm.post_id=qp.id),'[]'::json),'likes',(SELECT COUNT(*)::int FROM post_likes ql WHERE ql.post_id=qp.id),'comments',(SELECT COUNT(*)::int FROM post_comments qc WHERE qc.post_id=qp.id),'reposts',(SELECT COUNT(*)::int FROM post_reposts qr WHERE qr.post_id=qp.id),'saves',(SELECT COUNT(*)::int FROM post_saves qs WHERE qs.post_id=qp.id),'views',(SELECT COUNT(*)::int FROM post_views qv WHERE qv.post_id=qp.id)) FROM posts qp JOIN users qu ON qu.id=qp.author_id WHERE qp.id=p.quote_post_id) quote_post FROM posts p LEFT JOIN projects pr ON pr.id=p.project_id WHERE p.author_id=${user.id} ${search?sql`AND p.body ILIKE ${search}`:sql``} ${cursorPosts} ORDER BY p.created_at DESC,p.id DESC LIMIT ${limit+1}`);
    else if(type==="projects") items=await rows(sql`SELECT id,name,slug,description,stage,github_url,created_at FROM projects WHERE owner_id=${user.id} ${search?sql`AND (name ILIKE ${search} OR description ILIKE ${search})`:sql``} ${cursorProjects} ORDER BY created_at DESC,id DESC LIMIT ${limit+1}`);
    else if(type==="followers"||type==="following") { const following=type==="following"; items=await rows(following?sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type,u.bio,f.created_at item_created_at FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=${user.id} ${search?sql`AND (u.name ILIKE ${search} OR u.username ILIKE ${search} OR COALESCE(u.bio,'') ILIKE ${search})`:sql``} ${cursorPeople} ORDER BY f.created_at DESC,u.id DESC LIMIT ${limit+1}`:sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type,u.bio,f.created_at item_created_at FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=${user.id} ${search?sql`AND (u.name ILIKE ${search} OR u.username ILIKE ${search} OR COALESCE(u.bio,'') ILIKE ${search})`:sql``} ${cursorPeople} ORDER BY f.created_at DESC,u.id DESC LIMIT ${limit+1}`); }
    else return res.status(400).json({error:"Unsupported profile item type"});
    const hasMore=items.length>limit;const page=items.slice(0,limit);const last=page[page.length-1];
    const mapped=type==="posts"?page.map(p=>({id:p.id,authorId:p.author_id,text:p.body,createdAt:p.created_at,projectId:p.project_id,projectName:p.project_name,projectSlug:p.project_slug,linkUrl:p.link_url??null,quotePostId:p.quote_post_id??null,quotePost:p.quote_post??null,media:p.media??[],likes:Number(p.likes||0),comments:Number(p.comments||0),reposts:Number(p.reposts||0),saves:Number(p.saves||0)})):type==="projects"?page:page.map(p=>({id:p.id,name:p.name,username:p.username,avatarUrl:p.avatar_url??null,accountType:p.account_type,bio:p.bio??null,createdAt:p.item_created_at}));
    return res.json({data:{items:mapped,hasMore,nextCursor:hasMore?{createdAt:type==="projects"?last.created_at:last.item_created_at??last.created_at,id:last.id}:null}});
  }catch(error){console.error("[ProfileItems] Failed:",error);return res.status(500).json({error:"Unable to load profile items"});}
});

socialProfileLiveStableRouter.get("/users/:username/profile-live",async(req,res)=>{
  if(!db)return res.status(404).json({error:"Profile not found"});
  try{
    const [user]=await db.select({id:users.id,name:users.name,username:users.username,email:users.email,avatarUrl:users.avatarUrl,bio:users.bio,location:users.location,accountType:users.accountType,interests:users.interests,trustScore:users.trustScore,createdAt:users.createdAt}).from(users).where(ilike(users.username,String(req.params.username))).limit(1);
    if(!user)return res.status(404).json({error:"Profile not found"});
    let media:Row={};try{media=(await rows(sql`SELECT cover_url,profile_logo_url,cover_position_x,cover_position_y FROM users WHERE id=${user.id} LIMIT 1`))[0]??{};}catch{}
    let stats={followers:0,following:0,projects:0,posts:0};try{const r=(await rows(sql`SELECT (SELECT COUNT(*)::int FROM follows WHERE following_id=${user.id}) followers,(SELECT COUNT(*)::int FROM follows WHERE follower_id=${user.id}) following,(SELECT COUNT(*)::int FROM projects WHERE owner_id=${user.id}) projects,(SELECT COUNT(*)::int FROM posts WHERE author_id=${user.id}) posts`))[0];if(r)stats={followers:Number(r.followers||0),following:Number(r.following||0),projects:Number(r.projects||0),posts:Number(r.posts||0)};}catch{}
    let projects:Row[]=[];try{projects=await rows(sql`SELECT id,name,slug,description,stage,github_url,created_at FROM projects WHERE owner_id=${user.id} OR EXISTS(SELECT 1 FROM project_collaborators pc WHERE pc.project_id=projects.id AND pc.user_id=${user.id} AND pc.status='accepted') ORDER BY created_at DESC LIMIT 50`);}catch{}
    let posts:Row[]=[];try{posts=await rows(sql`SELECT p.id,p.author_id,p.body,p.created_at,p.project_id,p.agent_id,p.quote_post_id,p.link_url,pr.name project_name,pr.slug project_slug,a.name agent_name,a.slug agent_slug,(SELECT COUNT(*)::int FROM post_likes x WHERE x.post_id=p.id) likes,(SELECT COUNT(*)::int FROM post_comments x WHERE x.post_id=p.id) comments,(SELECT COUNT(*)::int FROM post_reposts x WHERE x.post_id=p.id) reposts,(SELECT COUNT(*)::int FROM post_saves x WHERE x.post_id=p.id) saves,COALESCE((SELECT json_agg(json_build_object('publicUrl',pm.public_url,'mimeType',pm.mime_type) ORDER BY pm.sort_order) FROM post_media pm WHERE pm.post_id=p.id),'[]'::json) media,(SELECT json_build_object('id',qp.id,'text',qp.body,'createdAt',qp.created_at,'linkUrl',qp.link_url,'author',json_build_object('id',qu.id,'name',qu.name,'username',qu.username,'avatarUrl',qu.avatar_url,'accountType',qu.account_type),'media',COALESCE((SELECT json_agg(json_build_object('publicUrl',qpm.public_url,'mimeType',qpm.mime_type) ORDER BY qpm.sort_order) FROM post_media qpm WHERE qpm.post_id=qp.id),'[]'::json),'likes',(SELECT COUNT(*)::int FROM post_likes ql WHERE ql.post_id=qp.id),'comments',(SELECT COUNT(*)::int FROM post_comments qc WHERE qc.post_id=qp.id),'reposts',(SELECT COUNT(*)::int FROM post_reposts qr WHERE qr.post_id=qp.id),'saves',(SELECT COUNT(*)::int FROM post_saves qs WHERE qs.post_id=qp.id)) FROM posts qp JOIN users qu ON qu.id=qp.author_id WHERE qp.id=p.quote_post_id) quote_post FROM posts p LEFT JOIN projects pr ON pr.id=p.project_id LEFT JOIN agents a ON a.id=p.agent_id WHERE p.author_id=${user.id} ORDER BY p.created_at DESC LIMIT 100`);}catch{}
    let followers:Row[]=[];try{followers=await rows(sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type,u.bio FROM follows f JOIN users u ON u.id=f.follower_id WHERE f.following_id=${user.id} ORDER BY f.created_at DESC LIMIT 100`);}catch{}
    let followingList:Row[]=[];try{followingList=await rows(sql`SELECT u.id,u.name,u.username,u.avatar_url,u.account_type,u.bio FROM follows f JOIN users u ON u.id=f.following_id WHERE f.follower_id=${user.id} ORDER BY f.created_at DESC LIMIT 100`);}catch{}
    let affiliations:Row[]=[];try{affiliations=await rows(sql`SELECT a.id,a.name,a.slug,a.type,a.website,a.verified,aa.role,aa.verified_at FROM agent_affiliations aa JOIN agents a ON a.id=aa.agent_id WHERE aa.user_id=${user.id} ORDER BY aa.verified_at DESC`);}catch{}
    let affiliationHistory:Row[]=[];try{affiliationHistory=await rows(sql`SELECT h.id,h.agent_id,h.role,h.event_type,h.created_at,a.name agent_name,a.slug agent_slug FROM agent_affiliation_history h JOIN agents a ON a.id=h.agent_id WHERE h.user_id=${user.id} ORDER BY h.created_at ASC`);}catch{}
    const historyByAgent=new Map<string,Row[]>();
    for(const h of affiliationHistory){const list=historyByAgent.get(String(h.agent_id))??[];list.push(h);historyByAgent.set(String(h.agent_id),list);}
    for(const a of affiliations){const key=String(a.id);if(!(historyByAgent.get(key)?.length)){historyByAgent.set(key,[{id:`initial-${a.id}`,agent_id:a.id,role:a.role,event_type:"affiliation",created_at:a.verified_at,agent_name:a.name,agent_slug:a.slug}]);}}
    const buildHistory=posts.filter(p=>p.project_id).sort((a,b)=>new Date(a.created_at).getTime()-new Date(b.created_at).getTime()).map(p=>({id:p.id,createdAt:p.created_at,postId:p.id,projectId:p.project_id,projectName:p.project_name,projectSlug:p.project_slug,text:p.body,authorId:p.author_id}));
    const mapPerson=(p:Row)=>({id:p.id,name:p.name,username:p.username,avatarUrl:p.avatar_url??null,accountType:p.account_type,bio:p.bio??null});
    return res.json({data:{user:{...user,avatarUrl:user.avatarUrl,coverUrl:media.cover_url??null,profileLogoUrl:media.profile_logo_url??null,coverPositionX:Number(media.cover_position_x??50),coverPositionY:Number(media.cover_position_y??50)},stats,projects,posts:posts.map(p=>({id:p.id,authorId:p.author_id,text:p.body,createdAt:p.created_at,projectId:p.project_id,projectName:p.project_name,projectSlug:p.project_slug,agentId:p.agent_id,agentName:p.agent_name,agentSlug:p.agent_slug,quotePostId:p.quote_post_id??null,quotePost:p.quote_post??null,linkUrl:p.link_url??null,media:p.media??[],likes:Number(p.likes||0),comments:Number(p.comments||0),reposts:Number(p.reposts||0),saves:Number(p.saves||0)})),buildHistory,followers:followers.map(mapPerson),following:followingList.map(mapPerson),affiliations:affiliations.map(a=>({id:a.id,name:a.name,slug:a.slug,type:a.type,website:a.website,verified:Boolean(a.verified),role:a.role,status:"accepted",timeline:(historyByAgent.get(String(a.id))??[]).map(h=>({id:h.id,role:h.role,eventType:h.event_type,createdAt:h.created_at}))}))}});
  }catch(error){console.error("[SocialProfileLiveStable] Failed:",error);return res.status(500).json({error:"Unable to load profile"});}
});
