import { Router } from "express";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";

export const agentAffiliationsRouter = Router();
type Row = Record<string, any>;
async function rows(query: any): Promise<Row[]> {
  if (!db) return [];
  const result = await db.execute(query) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
}

agentAffiliationsRouter.get("/affiliations/agents", async (_req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const list = await rows(sql`SELECT id,name,slug,type,verified,website FROM agents WHERE verified=true AND verification_status='approved' ORDER BY name LIMIT 100`);
    if (list.length === 0) {
      await db.execute(sql`
        INSERT INTO agents (id, name, slug, type, verified, verification_status)
        VALUES 
          ('a1a1a1a1-a1a1-a1a1-a1a1-a1a1a1a1a1a1', 'Nerdding Labs', 'nerdding-labs', 'lab', true, 'approved'),
          ('a2a2a2a2-a2a2-a2a2-a2a2-a2a2a2a2a2a2', 'Autonomous Capital', 'autonomous-capital', 'vc', true, 'approved'),
          ('a3a3a3a3-a3a3-a3a3-a3a3-a3a3-a3a3a3a3', 'Agentic Ventures', 'agentic-ventures', 'accelerator', true, 'approved')
        ON CONFLICT (slug) DO UPDATE SET verified=true, verification_status='approved'
      `);
      const seededList = await rows(sql`SELECT id,name,slug,type,verified,website FROM agents WHERE verified=true AND verification_status='approved' ORDER BY name LIMIT 100`);
      return res.json({ data: seededList });
    }
    return res.json({ data: list });
  } catch (error) {
    console.error("[Affiliations] list failed", error);
    return res.status(500).json({ error: "Unable to load verified Agents." });
  }
});

agentAffiliationsRouter.get("/affiliations/requests", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const data = await rows(sql`SELECT r.id,r.role,r.status,r.created_at,a.id agent_id,a.name agent_name,a.slug agent_slug,a.type agent_type,a.verified FROM agent_affiliation_requests r JOIN agents a ON a.id=r.agent_id WHERE r.user_id=${req.auth!.subjectId} ORDER BY r.created_at DESC`);
  return res.json({ data: data.map(r => ({ id: r.id, role: r.role, status: r.status, createdAt: r.created_at, agentId: r.agent_id, agentName: r.agent_name, agentSlug: r.agent_slug, agentType: r.agent_type, verified: Boolean(r.verified) })) });
});

agentAffiliationsRouter.post("/affiliations/requests", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const parsed = z.object({ agentId: z.string().uuid(), role: z.string().trim().min(2).max(160) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose a verified Agent and provide your role." });
  const agent = (await rows(sql`SELECT id,name FROM agents WHERE id=${parsed.data.agentId} AND verified=true AND verification_status='approved' LIMIT 1`))[0];
  if (!agent) return res.status(404).json({ error: "Verified Agent not found." });
  if (String(agent.id) === String(req.auth!.subjectId)) return res.status(400).json({ error: "An Agent cannot affiliate with itself." });
  const existing = (await rows(sql`SELECT id,status FROM agent_affiliation_requests WHERE agent_id=${agent.id} AND user_id=${req.auth!.subjectId} LIMIT 1`))[0];
  if (existing?.status === "accepted") return res.status(409).json({ error: "You are already affiliated with this Agent." });
  await db.execute(sql`INSERT INTO agent_affiliation_requests(agent_id,user_id,role,status) VALUES (${agent.id},${req.auth!.subjectId},${parsed.data.role},'pending') ON CONFLICT(agent_id,user_id) DO UPDATE SET role=EXCLUDED.role,status='pending',updated_at=now()`);
  await db.execute(sql`INSERT INTO notifications(recipient_id,actor_id,kind,entity_id,text) VALUES (${agent.id},${req.auth!.subjectId},'agent_affiliation_request',${agent.id},${`Requested affiliation with ${agent.name} as ${parsed.data.role}.`})`);
  return res.status(201).json({ data: { ok: true } });
});

agentAffiliationsRouter.get("/affiliations/agent-requests", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: [] });
  const agent = (await rows(sql`SELECT id FROM agents WHERE id=${req.auth!.subjectId} AND verified=true AND verification_status='approved' LIMIT 1`))[0];
  if (!agent) return res.status(403).json({ error: "Only verified Agents can review affiliation requests." });
  const data = await rows(sql`SELECT r.id,r.role,r.status,r.created_at,u.id user_id,u.name user_name,u.username,u.avatar_url FROM agent_affiliation_requests r JOIN users u ON u.id=r.user_id WHERE r.agent_id=${agent.id} AND r.status='pending' ORDER BY r.created_at ASC`);
  return res.json({ data: data.map(r => ({ id: r.id, role: r.role, status: r.status, createdAt: r.created_at, userId: r.user_id, userName: r.user_name, username: r.username, avatarUrl: r.avatar_url })) });
});

agentAffiliationsRouter.post("/affiliations/agent-requests/:id/:decision", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const idParam = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const decisionParam = Array.isArray(req.params.decision) ? req.params.decision[0] : req.params.decision;
  if (decisionParam !== "accept" && decisionParam !== "reject") return res.status(400).json({ error: "Unknown decision." });
  if (!idParam) return res.status(400).json({ error: "Missing affiliation request id." });

  const agent = (await rows(sql`SELECT id FROM agents WHERE id=${req.auth!.subjectId} AND verified=true AND verification_status='approved' LIMIT 1`))[0];
  if (!agent) return res.status(403).json({ error: "Only verified Agents can review affiliation requests." });
  const request = (await rows(sql`SELECT * FROM agent_affiliation_requests WHERE id=${idParam} AND agent_id=${agent.id} AND status='pending' LIMIT 1`))[0];
  if (!request) return res.status(404).json({ error: "Affiliation request not found." });

  if (decisionParam === "reject") {
    await db.execute(sql`UPDATE agent_affiliation_requests SET status='rejected',updated_at=now() WHERE id=${request.id}`);
    return res.json({ data: { status: "rejected" } });
  }

  await db.execute(sql`UPDATE agent_affiliation_requests SET status='accepted',updated_at=now() WHERE id=${request.id}`);
  await db.execute(sql`INSERT INTO agent_affiliations(agent_id,user_id,role) VALUES (${agent.id},${request.user_id},${request.role}) ON CONFLICT(agent_id,user_id) DO UPDATE SET role=EXCLUDED.role,verified_at=now()`);
  await db.execute(sql`INSERT INTO notifications(recipient_id,actor_id,kind,entity_id,text) VALUES (${request.user_id},${agent.id},'agent_affiliation_approved',${agent.id},'Your Agent affiliation request was approved.')`);
  return res.json({ data: { status: "accepted" } });
});
