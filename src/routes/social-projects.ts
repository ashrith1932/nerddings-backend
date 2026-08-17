import { Router } from "express";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const socialProjectsRouter = Router();

type Row = Record<string, any>;

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || `project-${Date.now()}`;
}

async function uniqueSlug(base: string) {
  if (!db) return base;
  const clean = slugify(base);
  const rows = await db.execute(sql`SELECT slug FROM projects WHERE slug LIKE ${clean + "%"}`) as unknown as Row[];
  const used = new Set(rows.map((r) => String(r.slug)));
  if (!used.has(clean)) return clean;
  let i = 2;
  while (used.has(`${clean}-${i}`)) i += 1;
  return `${clean}-${i}`;
}

socialProjectsRouter.get("/agents", async (_req, res) => {
  if (!db) return res.json({ data: [] });
  const rows = await db.execute(sql`SELECT id,name,slug,type,verified,domain,website FROM agents ORDER BY verified DESC, name ASC LIMIT 100`) as unknown as Row[];
  res.json({ data: rows });
});

socialProjectsRouter.get("/projects/:slug/members", async (req, res) => {
  if (!db) return res.json({ data: [] });
  const rows = await db.execute(sql`SELECT pc.user_id, pc.status, pc.created_at, u.name, u.username, u.avatar_url, u.account_type
    FROM project_collaborators pc JOIN users u ON u.id=pc.user_id
    JOIN projects p ON p.id=pc.project_id
    WHERE lower(p.slug)=lower(${req.params.slug}) AND pc.status='accepted'
    ORDER BY pc.created_at ASC`) as unknown as Row[];
  res.json({ data: rows });
});

socialProjectsRouter.post("/projects", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const parsed = z.object({
    name: z.string().trim().min(2).max(180),
    description: z.string().trim().min(2).max(5000),
    stage: z.string().trim().min(2).max(40),
    agentId: z.string().uuid().nullable().optional(),
    githubUrl: z.string().url().nullable().optional(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please provide a project name, description and stage." });

  if (parsed.data.agentId) {
    const agents = await db.execute(sql`SELECT id FROM agents WHERE id=${parsed.data.agentId} LIMIT 1`) as unknown as Row[];
    if (!agents[0]) return res.status(400).json({ error: "That organization does not exist." });
  }
  if (parsed.data.githubUrl) {
    try {
      const url = new URL(parsed.data.githubUrl);
      if (url.hostname.toLowerCase() !== "github.com") return res.status(400).json({ error: "GitHub URL must point to github.com." });
    } catch { return res.status(400).json({ error: "Invalid GitHub URL." }); }
  }

  const slug = await uniqueSlug(parsed.data.name);
  const id = randomUUID();
  const rows = await db.execute(sql`INSERT INTO projects (id, owner_id, agent_id, name, slug, description, stage, github_url)
    VALUES (${id}, ${req.auth!.subjectId}, ${parsed.data.agentId ?? null}, ${parsed.data.name}, ${slug}, ${parsed.data.description}, ${parsed.data.stage}, ${parsed.data.githubUrl ?? null})
    RETURNING id, owner_id, agent_id, name, slug, description, stage, github_url, created_at`) as unknown as Row[];

  await db.execute(sql`INSERT INTO project_collaborators (project_id,user_id,status) VALUES (${id},${req.auth!.subjectId},'accepted') ON CONFLICT (project_id,user_id) DO NOTHING`);
  return res.status(201).json({ data: rows[0] });
});

socialProjectsRouter.post("/projects/:slug/invitations", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const parsed = z.object({ userId: z.string().uuid() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "A valid user is required." });
  const projectRows = await db.execute(sql`SELECT id, owner_id FROM projects WHERE lower(slug)=lower(${req.params.slug}) LIMIT 1`) as unknown as Row[];
  const project = projectRows[0];
  if (!project) return res.status(404).json({ error: "Project not found." });
  if (String(project.owner_id) !== String(req.auth!.subjectId)) return res.status(403).json({ error: "Only the project creator can invite contributors." });
  if (String(parsed.data.userId) === String(req.auth!.subjectId)) return res.status(400).json({ error: "You are already the project creator." });
  const users = await db.execute(sql`SELECT id FROM users WHERE id=${parsed.data.userId} LIMIT 1`) as unknown as Row[];
  if (!users[0]) return res.status(404).json({ error: "User not found." });
  await db.execute(sql`INSERT INTO project_collaborators (project_id,user_id,status) VALUES (${project.id},${parsed.data.userId},'pending') ON CONFLICT (project_id,user_id) DO UPDATE SET status='pending'`);
  return res.status(201).json({ data: { ok: true } });
});

socialProjectsRouter.get("/project-invitations", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const rows = await db.execute(sql`SELECT pc.project_id, pc.status, pc.created_at, p.name, p.slug, u.name AS owner_name, u.username AS owner_username
    FROM project_collaborators pc JOIN projects p ON p.id=pc.project_id JOIN users u ON u.id=p.owner_id
    WHERE pc.user_id=${req.auth!.subjectId} AND pc.status='pending' ORDER BY pc.created_at DESC`) as unknown as Row[];
  res.json({ data: rows });
});

socialProjectsRouter.post("/project-invitations/:projectId/accept", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const rows = await db.execute(sql`UPDATE project_collaborators SET status='accepted' WHERE project_id=${req.params.projectId} AND user_id=${req.auth!.subjectId} AND status='pending' RETURNING project_id`) as unknown as Row[];
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
  const q = String(req.query.q ?? "").trim().replace(/^@/, "").toLowerCase();
  if (!q) return res.json({ data: [] });
  const users = await db.execute(sql`SELECT id,name,username,avatar_url,account_type FROM users WHERE lower(username) LIKE ${q + "%"} OR lower(name) LIKE ${"%" + q + "%"} ORDER BY username LIMIT 8`) as unknown as Row[];
  const agents = await db.execute(sql`SELECT id,name,slug,type,verified FROM agents WHERE lower(slug) LIKE ${q + "%"} OR lower(name) LIKE ${"%" + q + "%"} ORDER BY name LIMIT 8`) as unknown as Row[];
  res.json({ data: [...users.map((u) => ({ kind: "user", id: u.id, name: u.name, username: u.username, avatarUrl: u.avatar_url, accountType: u.account_type })), ...agents.map((a) => ({ kind: "agent", id: a.id, name: a.name, username: a.slug, verified: a.verified, accountType: a.type }))].slice(0, 10) });
});
