import { sql } from "drizzle-orm";
import { db } from "./client.js";

export async function ensureSocialSchema() {
  if (!db) return;
  await db.execute(sql`ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES post_comments(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS quote_post_id uuid REFERENCES posts(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_url text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS website text`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_comments_post_parent_idx ON post_comments(post_id, parent_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS posts_author_created_idx ON posts(author_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS follows_following_idx ON follows(following_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows(follower_id, created_at DESC)`);
}
