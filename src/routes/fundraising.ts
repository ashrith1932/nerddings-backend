import { Router } from "express";
import { z } from "zod";
import { requireAgent } from "../middleware/auth.js";
import { addFundraising, fundraisings } from "../lib/store.js";
import { db } from "../db/client.js";
import { fundraisings as fundraisingTable } from "../db/schema.js";

const fundraisingSchema = z.object({
  startupName: z.string().min(2).max(180),
  stage: z.enum(["Pre-seed", "Seed", "Series A", "Series B"]),
  industry: z.string().min(2).max(80),
  targetAmount: z.number().positive(),
  raisedAmount: z.number().nonnegative().default(0),
  currency: z.enum(["INR", "USD"]).default("INR"),
  investorCount: z.number().int().nonnegative().default(0),
  visibility: z.enum(["public", "investors-only"]).default("public"),
});

export const fundraisingRouter = Router();

fundraisingRouter.get("/", async (_req, res) => {
  const rows = db ? await db.select().from(fundraisingTable) : fundraisings;
  res.json({ data: rows.map((item) => ({ ...item, targetAmount: Number(item.targetAmount), raisedAmount: Number(item.raisedAmount), progress: Math.min(100, Math.round((Number(item.raisedAmount) / Number(item.targetAmount)) * 100)) })) });
});

fundraisingRouter.post("/", requireAgent, async (req, res) => {
  const parsed = fundraisingSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid fundraising profile", details: parsed.error.flatten() });
  if (db) {
    const [item] = await db.insert(fundraisingTable).values({ agentId: req.auth!.subjectId, ...parsed.data, targetAmount: String(parsed.data.targetAmount), raisedAmount: String(parsed.data.raisedAmount) }).returning();
    if (!item) return res.status(500).json({ error: "Unable to create fundraising profile." });
    return res.status(201).json({ data: { ...item, targetAmount: Number(item.targetAmount), raisedAmount: Number(item.raisedAmount), progress: Math.min(100, Math.round((Number(item.raisedAmount) / Number(item.targetAmount)) * 100)) } });
  }
  const item = addFundraising({ id: `fund-${Date.now()}`, agentId: req.auth!.subjectId, ...parsed.data, createdAt: new Date().toISOString() });
  return res.status(201).json({ data: { ...item, progress: Math.min(100, Math.round((item.raisedAmount / item.targetAmount) * 100)) } });
});
