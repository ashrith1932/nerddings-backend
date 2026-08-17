import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const projectDetailsRouter = Router();

projectDetailsRouter.get("/projects/:slug", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Project not found" });
  const rows = await db.execute(sql`SELECT p.id,p.name,p.slug,p.description,p.stage,p.github_url,p.created_at,
    u.id owner_id,u.name owner_name,u.username owner_username,u.avatar_url owner_avatar,
    a.id agent_id,a.name agent_name,a.slug agent_slug,a.domain agent_domain,a.verified agent_verified,a.website agent_website
    FROM projects p JOIN users u ON u.id=p.owner_id LEFT JOIN agents a ON a.id=p.agent_id
    WHERE lower(p.slug)=lower(${req.params.slug}) LIMIT 1`);
  const row = (rows as unknown as Record<string,any>[])[0];
  if (!row) return res.status(404).json({ error: "Project not found" });
  const posts = await db.execute(sql`SELECT p.id,p.body,p.created_at FROM posts p WHERE p.project_id=${row.id} ORDER BY p.created_at DESC LIMIT 8`);
  return res.json({ data: { id: row.id, name: row.name, slug: row.slug, description: row.description, stage: row.stage, githubUrl: row.github_url, createdAt: row.created_at, owner: { id: row.owner_id, name: row.owner_name, username: row.owner_username, avatarUrl: row.owner_avatar }, agent: row.agent_id ? { id: row.agent_id, name: row.agent_name, slug: row.agent_slug, domain: row.agent_domain, website: row.agent_website, verified: row.agent_verified } : null, posts } });
});
