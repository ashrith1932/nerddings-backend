import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const socialProjectsRouter = Router();
type Row = Record<string, any>;
type QueryResultLike<T> = T[] | { rows: T[] };

async function executeRows<T extends Row>(query: any): Promise<T[]> {
  const result = await db!.execute(query) as unknown as QueryResultLike<T>;
  return Array.isArray(result) ? result : result.rows;
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `project-${Date.now()}`;
}

async function uniqueSlug(base: string) {
  if (!db) return base;
  const clean = slugify(base);
  const rows = await executeRows<Row>(sql`SELECT slug FROM projects WHERE slug LIKE ${clean + "%"}`);
  const used = new Set(rows.map((r) => String(r.slug)));
  if (!used.has(clean)) return clean;
  let i = 2;
  while (used.has(`${clean}-${i}`)) i += 1;
  return `${clean}-${i}`;
}

socialProjectsRouter.get("/agents", async (_req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const rows = await executeRows<Row>(sql`SELECT id,name,slug,type,verified,domain,website FROM agents WHERE verified=true AND verification_status='approved' ORDER BY name ASC LIMIT 100`);
    res.json({ data: rows });
  } catch (error) { console.error("[Projects] Failed to load agents:", error); res.status(500).json({ error: "Unable to load organizations." }); }
});

socialProjectsRouter.get("/projects/:slug/members", async (req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const rows = await executeRows<Row>(sql`
      SELECT pc.user_id, pc.status, pc.created_at, u.name, u.username, u.avatar_url, u.account_type
      FROM project_collaborators pc
      JOIN users u ON u.id=pc.user_id
      JOIN projects p ON p.id=pc.project_id
      WHERE lower(p.slug)=lower(${req.params.slug}) AND pc.status='accepted'
      ORDER BY pc.created_at ASC
    `);
    res.json({ data: rows });
  } catch (error) { console.error("[Projects] Failed to load members:", error); res.status(500).json({ error: "Unable to load collaborators." }); }
});

socialProjectsRouter.get("/projects/:slug/github-commits", async (req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const rows = await executeRows<Row>(sql`SELECT github_url FROM projects WHERE lower(slug)=lower(${req.params.slug}) LIMIT 1`);
    const githubUrl = rows[0]?.github_url;
    if (!githubUrl) return res.json({ data: [] });
    const parsed = new URL(String(githubUrl));
    if (parsed.hostname.toLowerCase() !== "github.com") return res.json({ data: [] });
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts.length < 2) return res.json({ data: [] });
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(`https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/commits?per_page=8`, { headers: { Accept: "application/vnd.github+json", "User-Agent": "Nerdding" }, signal: controller.signal });
      if (!response.ok) return res.json({ data: [] });
      const commits = await response.json() as any[];
      return res.json({ data: commits.map((commit) => ({ sha: commit.sha, message: String(commit.commit?.message ?? "").split("\n")[0], author: commit.commit?.author?.name ?? commit.author?.login ?? "GitHub", date: commit.commit?.author?.date ?? null, url: commit.html_url })) });
    } finally { clearTimeout(timeout); }
  } catch (error) { console.warn("[Projects] GitHub commits unavailable:", error); return res.json({ data: [] }); }
});

socialProjectsRouter.post("/projects", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  try {
    const parsed = z.object({
      name: z.string().trim().min(2).max(180),
      description: z.string().trim().min(2).max(5000),
      stage: z.string().trim().min(2).max(40),
      agentId: z.string().uuid().nullable().optional(),
      githubUrl: z.string().url().nullable().optional(),
    }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "Please provide a project name, description and stage." });
    if (parsed.data.agentId) {
      const agents = await executeRows<Row>(sql`SELECT id FROM agents WHERE id=${parsed.data.agentId} AND verified=true AND verification_status='approved' LIMIT 1`);
      if (!agents[0]) return res.status(400).json({ error: "That organization is not a verified Agent." });
    }
    if (parsed.data.githubUrl) {
      try { const url = new URL(parsed.data.githubUrl); if (url.hostname.toLowerCase() !== "github.com") return res.status(400).json({ error: "GitHub URL must point to github.com." }); }
      catch { return res.status(400).json({ error: "Invalid GitHub URL." }); }
    }
    const slug = await uniqueSlug(parsed.data.name);
    const id = randomUUID();
    const rows = await executeRows<Row>(sql`
      INSERT INTO projects (id, owner_id, agent_id, name, slug, description, stage, github_url)
      VALUES (${id}, ${req.auth!.subjectId}, ${parsed.data.agentId ?? null}, ${parsed.data.name}, ${slug}, ${parsed.data.description}, ${parsed.data.stage}, ${parsed.data.githubUrl ?? null})
      RETURNING id, owner_id, agent_id, name, slug, description, stage, github_url, created_at
    `);
    await db.execute(sql`INSERT INTO project_collaborators (project_id,user_id,status) VALUES (${id},${req.auth!.subjectId},'accepted') ON CONFLICT (project_id,user_id) DO UPDATE SET status='accepted'`);
    return res.status(201).json({ data: rows[0] });
  } catch (error) { console.error("[Projects] Failed to create project:", error); return res.status(500).json({ error: "Project could not be created right now." }); }
});

socialProjectsRouter.post("/projects/:slug/invitations", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  try {
    const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: "A valid user is required." });
    const projectRows = await executeRows<Row>(sql`SELECT id, owner_id, name FROM projects WHERE lower(slug)=lower(${req.params.slug}) LIMIT 1`);
    const project = projectRows[0];
    if (!project) return res.status(404).json({ error: "Project not found." });
    if (String(project.owner_id) !== String(req.auth!.subjectId)) return res.status(403).json({ error: "Only the project creator can invite contributors." });
    if (String(parsed.data.userId) === String(req.auth!.subjectId)) return res.status(400).json({ error: "You are already the project creator." });
    const users = await executeRows<Row>(sql`SELECT id, username FROM users WHERE id=${parsed.data.userId} LIMIT 1`);
    if (!users[0]) return res.status(404).json({ error: "User not found." });
    const existing = await executeRows<Row>(sql`SELECT status FROM project_collaborators WHERE project_id=${project.id} AND user_id=${parsed.data.userId} LIMIT 1`);
    if (existing[0]?.status === "accepted") return res.status(409).json({ error: "User is already a contributor." });
    await db.execute(sql`INSERT INTO project_collaborators (project_id,user_id,status) VALUES (${project.id},${parsed.data.userId},'pending') ON CONFLICT (project_id,user_id) DO UPDATE SET status='pending', created_at=now()`);
    await db.execute(sql`INSERT INTO notifications (recipient_id, actor_id, kind, entity_id, text) VALUES (${parsed.data.userId},${req.auth!.subjectId},'project_invitation',${project.id},${`You were invited to collaborate on ${project.name}.`})`);
    return res.status(201).json({ data: { ok: true, username: users[0].username } });
  } catch (error) { console.error("[Projects] Failed to invite collaborator:", error); return res.status(500).json({ error: "Invitation could not be sent." }); }
});

socialProjectsRouter.get("/project-invitations", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const rows = await executeRows<Row>(sql`SELECT pc.project_id, pc.status, pc.created_at, p.name, p.slug, u.name AS owner_name, u.username AS owner_username FROM project_collaborators pc JOIN projects p ON p.id=pc.project_id JOIN users u ON u.id=p.owner_id WHERE pc.user_id=${req.auth!.subjectId} AND pc.status='pending' ORDER BY pc.created_at DESC`);
  res.json({ data: rows });
});

socialProjectsRouter.post("/project-invitations/:projectId/accept", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const rows = await executeRows<Row>(sql`UPDATE project_collaborators SET status='accepted' WHERE project_id=${req.params.projectId} AND user_id=${req.auth!.subjectId} AND status='pending' RETURNING project_id`);
  if (!rows[0]) return res.status(404).json({ error: "Invitation not found." });
  res.json({ data: { ok: true } });
});

socialProjectsRouter.post("/project-invitations/:projectId/decline", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  await db.execute(sql`DELETE FROM project_collaborators WHERE project_id=${req.params.projectId} AND user_id=${req.auth!.subjectId} AND status='pending'`);
  res.json({ data: { ok: true } });
});

socialProjectsRouter.get("/mentions", async (req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const q = String(req.query.q ?? "").trim().replace(/^@/, "").toLowerCase();
    if (!q) return res.json({ data: [] });
    const users = await executeRows<Row>(sql`SELECT id,name,username,avatar_url,account_type FROM users WHERE lower(username) LIKE ${q + "%"} OR lower(name) LIKE ${"%" + q + "%"} ORDER BY username LIMIT 8`);
    const agents = await executeRows<Row>(sql`SELECT id,name,slug,type,verified FROM agents WHERE verified=true AND verification_status='approved' AND (lower(slug) LIKE ${q + "%"} OR lower(name) LIKE ${"%" + q + "%"}) ORDER BY name LIMIT 8`);
    res.json({ data: [...users.map((u) => ({ kind: "user", id: u.id, name: u.name, username: u.username, avatarUrl: u.avatar_url, accountType: u.account_type })), ...agents.map((a) => ({ kind: "agent", id: a.id, name: a.name, username: a.slug, verified: a.verified, accountType: a.type }))].slice(0, 10) });
  } catch (error) { console.error("[Projects] Mention lookup failed:", error); res.json({ data: [] }); }
});
