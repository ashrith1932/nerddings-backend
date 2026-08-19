import { Router } from "express";
import { sql } from "drizzle-orm";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const projectInterestsRouter = Router();
type Row = Record<string, any>;
async function rows(query: any): Promise<Row[]> {
  const result = await db!.execute(query) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
}

async function projectByIdOrSlug(value: string) {
  const found = await rows(sql`SELECT id FROM projects WHERE id::text=${value} OR lower(slug)=lower(${value}) LIMIT 1`);
  return found[0] ?? null;
}

projectInterestsRouter.post("/projects/:projectId/interest", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  try {
    const project = await projectByIdOrSlug(String(req.params.projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const existing = await rows(sql`SELECT 1 FROM project_interests WHERE project_id=${project.id} AND user_id=${req.auth!.subjectId} LIMIT 1`);
    let active: boolean;
    if (existing[0]) {
      await db.execute(sql`DELETE FROM project_interests WHERE project_id=${project.id} AND user_id=${req.auth!.subjectId}`);
      active = false;
    } else {
      await db.execute(sql`INSERT INTO project_interests(project_id,user_id) VALUES(${project.id},${req.auth!.subjectId}) ON CONFLICT DO NOTHING`);
      active = true;
    }
    const countRows = await rows(sql`SELECT COUNT(*)::int AS count FROM project_interests WHERE project_id=${project.id}`);
    return res.json({ data: { active, count: Number(countRows[0]?.count ?? 0) } });
  } catch (error) {
    console.error("[ProjectInterests] Toggle failed:", error);
    return res.status(500).json({ error: "Unable to update project interest" });
  }
});

projectInterestsRouter.get("/projects/:projectId/interest", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  try {
    const project = await projectByIdOrSlug(String(req.params.projectId));
    if (!project) return res.status(404).json({ error: "Project not found" });
    const result = await rows(sql`SELECT COUNT(*)::int AS count, EXISTS(SELECT 1 FROM project_interests WHERE project_id=${project.id} AND user_id=${req.auth!.subjectId}) AS active FROM project_interests WHERE project_id=${project.id}`);
    return res.json({ data: { active: Boolean(result[0]?.active), count: Number(result[0]?.count ?? 0) } });
  } catch (error) {
    console.error("[ProjectInterests] Read failed:", error);
    return res.status(500).json({ error: "Unable to load project interest" });
  }
});
