import { sql } from "drizzle-orm";
import { db } from "./client.js";

export async function ensureCheckmarkSchema() {
  if (!db) return;
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS checkmark_type varchar(24)`);
  await db.execute(sql`UPDATE users SET checkmark_type='gold' WHERE account_type='agent' AND (checkmark_type IS NULL OR checkmark_type='')`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS users_checkmark_type_idx ON users(checkmark_type)`);
}
