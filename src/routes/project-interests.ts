import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const projectInterestsRouter = Router();
type Row = Record<string, any>;
async function rows(query: any): Promise<Row[]> { const result = await db!.execute(query) as unknown as Row[] | { rows: Row[] }; return Array.isArray(result) ? result : result.rows; }
async function projectByIdOrSlug(value: string) { return (await rows(sql`SELECT id FROM projects WHERE id::text=${value} OR lower(slug)=lower(${value}) LIMIT 1`))[0] ?? null; }

projectInterestsRouter.post("/projects/:projectId/interest", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  try {
    const project = await projectByIdOrSlug(String(req.params.projectId)); if (!project) return res.status(404).json({ error: "Project not found" });
    const existing = await rows(sql`SELECT 1 FROM project_interests WHERE project_id=${project.id} AND user_id=${req.auth!.subjectId} LIMIT 1`);
    const active = !existing[0];
    if (active) await db.execute(sql`INSERT INTO project_interests(project_id,user_id) VALUES(${project.id},${req.auth!.subjectId}) ON CONFLICT DO NOTHING`);
    else await db.execute(sql`DELETE FROM project_interests WHERE project_id=${project.id} AND user_id=${req.auth!.subjectId}`);
    const countRows = await rows(sql`SELECT COUNT(*)::int AS count FROM project_interests WHERE project_id=${project.id}`);
    return res.json({ data: { active, count: Number(countRows[0]?.count ?? 0) } });
  } catch (error) { console.error("[ProjectInterests] Toggle failed:", error); return res.status(500).json({ error: "Unable to update project interest" }); }
});

projectInterestsRouter.get("/projects/:projectId/interest", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  try {
    const project = await projectByIdOrSlug(String(req.params.projectId)); if (!project) return res.status(404).json({ error: "Project not found" });
    const result = await rows(sql`SELECT COUNT(*)::int AS count, EXISTS(SELECT 1 FROM project_interests WHERE project_id=${project.id} AND user_id=${req.auth!.subjectId}) AS active FROM project_interests WHERE project_id=${project.id}`);
    return res.json({ data: { active: Boolean(result[0]?.active), count: Number(result[0]?.count ?? 0) } });
  } catch (error) { console.error("[ProjectInterests] Read failed:", error); return res.status(500).json({ error: "Unable to load project interest" }); }
});

projectInterestsRouter.get("/users/:username/interests", async (req, res) => {
  if (!db) return res.status(404).json({ error: "Profile not found" });
  try {
    const items = await rows(sql`SELECT p.id,p.name,p.slug,p.description,p.stage,p.github_url,p.created_at,u.id owner_id,u.name owner_name,u.username owner_username,u.avatar_url owner_avatar,pi.created_at interested_at,(SELECT COUNT(*)::int FROM project_interests x WHERE x.project_id=p.id) interest_count FROM project_interests pi JOIN users viewer ON viewer.id=pi.user_id JOIN projects p ON p.id=pi.project_id JOIN users u ON u.id=p.owner_id WHERE viewer.username ILIKE ${String(req.params.username)} ORDER BY pi.created_at DESC LIMIT 100`);
    return res.json({ data: items.map(p => ({ id:p.id,name:p.name,slug:p.slug,description:p.description,stage:p.stage,github_url:p.github_url,created_at:p.created_at,interestCount:Number(p.interest_count ?? 0),interestedAt:p.interested_at,owner:{id:p.owner_id,name:p.owner_name,username:p.owner_username,avatarUrl:p.owner_avatar} })) });
  } catch (error) { console.error("[ProjectInterests] Profile interests failed:", error); return res.status(500).json({ error: "Unable to load profile interests" }); }
});
