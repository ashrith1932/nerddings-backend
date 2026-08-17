import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const agentDetailsRouter = Router();

agentDetailsRouter.get("/agents/:slug", async (req,res)=>{
 if(!db)return res.status(404).json({error:"Organization not found"});
 const rows=await db.execute(sql`SELECT id,name,slug,type,verified,domain,website,created_at FROM agents WHERE lower(slug)=lower(${req.params.slug}) LIMIT 1`);
 const agent=(rows as unknown as Record<string,any>[])[0];
 if(!agent)return res.status(404).json({error:"Organization not found"});
 const projects=await db.execute(sql`SELECT id,name,slug,description,stage,github_url,created_at FROM projects WHERE agent_id=${agent.id} ORDER BY created_at DESC`);
 return res.json({data:{agent,projects,followers:0,posts:0}});
});
