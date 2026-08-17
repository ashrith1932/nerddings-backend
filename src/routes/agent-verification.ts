import { Router } from "express";
import { randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { db } from "../db/client.js";
import { getUser } from "../lib/auth-store.js";
import { verificationAdminEmails } from "../config/env.js";

export const agentVerificationRouter = Router();
type Row = Record<string, any>;

autoNormalizeDomain;
function normalizeDomain(value: string) {
  let candidate = value.trim().toLowerCase();
  if (!candidate) throw new Error("INVALID_DOMAIN");
  if (!candidate.includes("://")) candidate = `https://${candidate}`;
  const url = new URL(candidate);
  const domain = url.hostname.replace(/^www\./, "");
  if (!domain || domain.includes("@") || domain.includes("/")) throw new Error("INVALID_DOMAIN");
  return domain;
}

function slugify(value: string) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 90) || `agent-${Date.now()}`;
}

async function rows(query: any): Promise<Row[]> {
  if (!db) return [];
  const result = await db.execute(query) as unknown as Row[] | { rows: Row[] };
  return Array.isArray(result) ? result : result.rows;
}

async function reviewer(req: any, res: any, next: any) {
  if (!req.auth?.subjectId) return res.status(401).json({ error: "Authentication required." });
  const user = await getUser(req.auth.subjectId);
  if (!user || !verificationAdminEmails.has(user.email.toLowerCase())) return res.status(403).json({ error: "Verification chamber access is restricted to the Nerdding review team." });
  req.verificationReviewer = user.id;
  return next();
}

agentVerificationRouter.post("/apply", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });

  const parsed = z.object({
    organizationName: z.string().trim().min(2).max(180),
    organizationType: z.string().trim().min(2).max(80),
    website: z.string().url().max(2000),
    domain: z.string().trim().min(3).max(255),
    country: z.string().trim().min(2).max(120),
    description: z.string().trim().min(20).max(4000),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please provide the organization name, type, website, domain, country and a useful description." });

  let domain: string;
  try { domain = normalizeDomain(parsed.data.domain); }
  catch { return res.status(400).json({ error: "Enter a valid organization domain, for example example.com." }); }

  const existing = await rows(sql`
    SELECT * FROM agent_verification_requests
    WHERE user_id=${req.auth!.subjectId}
      AND status IN ('pending_dns','pending_review')
    ORDER BY created_at DESC LIMIT 1
  `);
  if (existing[0]) return res.status(409).json({ error: "You already have an active Agent verification request.", data: serializeRequest(existing[0]) });

  const id = randomUUID();
  const token = `nerdding-agent-${randomUUID()}`;
  const recordName = `_nerdding-verification.${domain}`;
  const created = await rows(sql`
    INSERT INTO agent_verification_requests
      (id,user_id,organization_name,organization_type,website,domain,country,description,dns_record_name,dns_record_value,status)
    VALUES
      (${id},${req.auth!.subjectId},${parsed.data.organizationName},${parsed.data.organizationType},${parsed.data.website},${domain},${parsed.data.country},${parsed.data.description},${recordName},${token},'pending_dns')
    RETURNING *
  `);

  return res.status(201).json({ data: serializeRequest(created[0]) });
});

function serializeRequest(row: Row) {
  return {
    id: row.id,
    organizationName: row.organization_name,
    organizationType: row.organization_type,
    website: row.website,
    domain: row.domain,
    country: row.country,
    description: row.description,
    dnsRecordName: row.dns_record_name,
    dnsRecordValue: row.dns_record_value,
    dnsVerified: Boolean(row.dns_verified),
    status: row.status,
    verificationNote: row.verification_note ?? null,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    createdAt: row.created_at,
  };
}

agentVerificationRouter.get("/me", requireAuth, async (req, res) => {
  if (!db) return res.json({ data: null });
  const request = await rows(sql`
    SELECT * FROM agent_verification_requests
    WHERE user_id=${req.auth!.subjectId}
    ORDER BY created_at DESC LIMIT 1
  `);
  return res.json({ data: request[0] ? serializeRequest(request[0]) : null });
});

agentVerificationRouter.post("/:id/verify-dns", requireAuth, async (req, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const requestRows = await rows(sql`
    SELECT * FROM agent_verification_requests
    WHERE id=${req.params.id} AND user_id=${req.auth!.subjectId}
    LIMIT 1
  `);
  const request = requestRows[0];
  if (!request) return res.status(404).json({ error: "Verification request not found." });
  if (request.status === "approved") return res.json({ data: serializeRequest(request), verified: true });
  if (request.status !== "pending_dns") return res.status(409).json({ error: "This request is already waiting for team review or has been rejected.", data: serializeRequest(request) });

  try {
    const records = await dns.resolveTxt(request.dns_record_name);
    const values = records.map((record) => record.join(""));
    if (!values.includes(request.dns_record_value)) {
      return res.status(422).json({ error: "The DNS TXT record was not found yet. DNS changes can take some time to propagate." });
    }
  } catch {
    return res.status(422).json({ error: "We could not find the DNS TXT record yet. Check the record name and value, then try again." });
  }

  const updated = await rows(sql`
    UPDATE agent_verification_requests
    SET dns_verified=true,status='pending_review',submitted_at=now(),updated_at=now()
    WHERE id=${request.id}
    RETURNING *
  `);
  return res.json({ data: serializeRequest(updated[0]), verified: true });
});

agentVerificationRouter.get("/review-queue", requireAuth, reviewer, async (_req, res) => {
  if (!db) return res.json({ data: [] });
  const queue = await rows(sql`
    SELECT r.*, u.name AS applicant_name, u.username AS applicant_username, u.email AS applicant_email
    FROM agent_verification_requests r
    JOIN users u ON u.id=r.user_id
    WHERE r.status='pending_review' AND r.dns_verified=true
    ORDER BY r.submitted_at ASC
  `);
  return res.json({ data: queue.map((row) => ({ ...serializeRequest(row), applicant: { id: row.user_id, name: row.applicant_name, username: row.applicant_username, email: row.applicant_email } })) });
});

agentVerificationRouter.post("/:id/review", requireAuth, reviewer, async (req: any, res) => {
  if (!db) return res.status(503).json({ error: "Database unavailable" });
  const parsed = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(2000).default("") }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Choose approve or reject." });

  const requestRows = await rows(sql`
    SELECT r.*, u.name AS applicant_name, u.username AS applicant_username
    FROM agent_verification_requests r
    JOIN users u ON u.id=r.user_id
    WHERE r.id=${req.params.id}
    LIMIT 1
  `);
  const request = requestRows[0];
  if (!request) return res.status(404).json({ error: "Verification request not found." });
  if (request.status !== "pending_review" || !request.dns_verified) return res.status(409).json({ error: "This request is not ready for review." });

  if (parsed.data.decision === "reject") {
    await db.execute(sql`
      UPDATE agent_verification_requests
      SET status='rejected',verification_note=${parsed.data.note || "The verification team could not approve this organization."},reviewed_at=now(),reviewer_id=${req.verificationReviewer},updated_at=now()
      WHERE id=${request.id}
    `);
    return res.json({ data: { status: "rejected" } });
  }

  const slugBase = slugify(request.applicant_username || request.organization_name);
  const slugRows = await rows(sql`SELECT slug FROM agents WHERE slug LIKE ${slugBase + "%"}`);
  const used = new Set(slugRows.map((row) => String(row.slug)));
  let slug = slugBase;
  let suffix = 2;
  while (used.has(slug)) slug = `${slugBase}-${suffix++}`;

  await db.execute(sql`
    INSERT INTO agents
      (id,name,slug,type,verified,verification_status,verification_note,reviewed_at,domain,website)
    VALUES
      (${request.user_id},${request.organization_name},${slug},${request.organization_type},true,'approved',${parsed.data.note || null},now(),${request.domain},${request.website})
    ON CONFLICT (id) DO UPDATE SET
      name=EXCLUDED.name,
      slug=EXCLUDED.slug,
      type=EXCLUDED.type,
      verified=true,
      verification_status='approved',
      verification_note=EXCLUDED.verification_note,
      reviewed_at=now(),
      domain=EXCLUDED.domain,
      website=EXCLUDED.website
  `);

  await db.execute(sql`UPDATE users SET account_type='agent',onboarding_completed=true WHERE id=${request.user_id}`);
  await db.execute(sql`
    UPDATE agent_verification_requests
    SET status='approved',verification_note=${parsed.data.note || null},reviewed_at=now(),reviewer_id=${req.verificationReviewer},updated_at=now()
    WHERE id=${request.id}
  `);

  return res.json({ data: { status: "approved", agentId: request.user_id } });
});
