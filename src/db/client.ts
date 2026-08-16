import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "../config/env.js";

export const pool = env.DATABASE_URL ? new Pool({ connectionString: env.DATABASE_URL, max: 10 }) : null;
export const db = pool ? drizzle(pool) : null;

export function isDatabaseConfigured() {
  return Boolean(pool);
}
