import { Router } from "express";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

type Row=Record<string,any>;
export const socialPostStableRouter=Router();
async function rows(query:any):Promise<Row[]>{const result=await db!.execute(query) as unknown as Row[]|{rows:Row[]};return Array.isArray(result)?result:result.rows;}

socialPostStableRouter.get("/post-options",requireAuth,async(req,res)=>{
  if(!db)return res.json({data:{projects:[],agents:[]}});
  const projects=await rows(sql`SELECT p.id,p.name,p.slug,p.stage FROM projects p WHERE p.owner_id=${req.auth!.subjectId} OR EXISTS(SELECT 1 FROM project_collaborators pc WHERE pc.project_id=p.id AND pc.user_id=${req.auth!.subjectId} AND pc.status='accepted') ORDER BY p.name LIMIT 100`);
  const agents=await rows(sql`SELECT a.id,a.name,a.slug,a.type,a.verified FROM agents a WHERE a.verified=true AND a.verification_status='approved' AND (EXISTS(SELECT 1 FROM agent_affiliations aa WHERE aa.agent_id=a.id AND aa.user_id=${req.auth!.subjectId}) OR EXISTS(SELECT 1 FROM projects p WHERE p.agent_id=a.id AND (p.owner_id=${req.auth!.subjectId} OR EXISTS(SELECT 1 FROM project_collaborators pc WHERE pc.project_id=p.id AND pc.user_id=${req.auth!.subjectId} AND pc.status='accepted')))) ORDER BY a.name LIMIT 100`);
  return res.json({data:{projects,agents}});
});

socialPostStableRouter.post("/posts",requireAuth,async(req,res)=>{
  if(!db)return res.status(503).json({error:"Database unavailable"});
  const parsed=z.object({body:z.string().trim().min(1).max(5000),projectSlug:z.string().max(100).optional(),agentSlug:z.string().max(100).optional(),linkUrl:z.string().url().max(2000).nullable().optional(),media:z.array(z.object({path:z.string(),mimeType:z.string(),publicUrl:z.string().url().optional()})).max(10).default([])}).safeParse(req.body);
  if(!parsed.success)return res.status(400).json({error:"Write an update before publishing.",details:parsed.error.flatten()});
  try{
    let projectId:string|null=null; let agentId:string|null=null;
    if(parsed.data.projectSlug){const p=(await rows(sql`SELECT p.id FROM projects p WHERE lower(p.slug)=lower(${parsed.data.projectSlug}) AND (p.owner_id=${req.auth!.subjectId} OR EXISTS(SELECT 1 FROM project_collaborators pc WHERE pc.project_id=p.id AND pc.user_id=${req.auth!.subjectId} AND pc.status='accepted')) LIMIT 1`))[0];if(!p)return res.status(403).json({error:"You can only mention projects where you are an owner or accepted collaborator."});projectId=String(p.id);}
    if(parsed.data.agentSlug){const a=(await rows(sql`SELECT id FROM agents WHERE lower(slug)=lower(${parsed.data.agentSlug}) AND verified=true AND verification_status='approved' LIMIT 1`))[0];if(!a)return res.status(404).json({error:"Verified Agent not found."});agentId=String(a.id);}
    const id=randomUUID();
    const created=(await rows(sql`INSERT INTO posts(id,author_id,project_id,agent_id,body,link_url,proof_of_work_score) VALUES (${id},${req.auth!.subjectId},${projectId},${agentId},${parsed.data.body},${parsed.data.linkUrl??null},${parsed.data.media.length?'0.7':'0'}) RETURNING id,body,project_id,agent_id,link_url,created_at`))[0];
    if(parsed.data.media.length){for(const [index,media] of parsed.data.media.entries())await db.execute(sql`INSERT INTO post_media(post_id,storage_path,public_url,mime_type,sort_order) VALUES (${id},${media.path},${media.publicUrl??null},${media.mimeType},${index})`);}
    return res.status(201).json({data:{id:created.id,body:created.body,projectId:created.project_id,agentId:created.agent_id,projectSlug:parsed.data.projectSlug??null,agentSlug:parsed.data.agentSlug??null,linkUrl:created.link_url,media:parsed.data.media}});
  }catch(error){console.error("[SocialPostStable] Failed:",error);return res.status(500).json({error:"Unable to publish this post right now."});}
});
