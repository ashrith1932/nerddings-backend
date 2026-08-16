import { Router } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { createUploadUrl, storageConfigured } from "../lib/storage.js";

export const uploadsRouter = Router();

uploadsRouter.post("/signed-url", requireAuth, async (req, res) => {
  if (!storageConfigured()) return res.status(503).json({ error: "Media storage is not configured. Add Supabase Storage credentials." });
  const parsed = z.object({ fileName: z.string().min(1).max(180), contentType: z.string().regex(/^(image|video)\//), size: z.number().int().positive().max(25 * 1024 * 1024) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Images and videos must be under 25 MB." });
  try { return res.json({ data: await createUploadUrl(req.auth!.subjectId, parsed.data.fileName, parsed.data.contentType) }); }
  catch { return res.status(502).json({ error: "Unable to prepare media upload." }); }
});
