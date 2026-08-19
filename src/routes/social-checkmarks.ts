import { Router } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db/client.js";

export const socialCheckmarksRouter = Router();

type Row = { username: string; checkmark_type: string | null; account_type: string };

socialCheckmarksRouter.get("/checkmarks", async (_req, res) => {
  if (!db) return res.json({ data: [] });
  try {
    const result = await db.execute(sql<Row>`
      SELECT username, checkmark_type, account_type
      FROM users
      WHERE username IS NOT NULL
    `) as unknown as Row[] | { rows: Row[] };
    const rows = Array.isArray(result) ? result : result.rows;
    return res.json({
      data: rows.map((row) => ({
        username: row.username,
        checkmarkType: row.checkmark_type || (row.account_type === "agent" ? "gold" : null),
      })).filter((row) => row.checkmarkType),
    });
  } catch (error) {
    console.error("[SocialCheckmarks] Failed to load checkmarks:", error);
    return res.status(500).json({ error: "Unable to load checkmarks" });
  }
});
