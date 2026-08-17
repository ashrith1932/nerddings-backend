import { sql } from "drizzle-orm";
import { db } from "./client.js";

export async function ensureSocialSchema() {
  if (!db) return;

  await db.execute(sql`ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES post_comments(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS quote_post_id uuid REFERENCES posts(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_url text`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_url text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS website text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_status varchar(20) NOT NULL DEFAULT 'pending'`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_note text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_verification_requests (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      organization_name varchar(180) NOT NULL,
      organization_type varchar(80) NOT NULL,
      website text NOT NULL,
      domain varchar(255) NOT NULL,
      country varchar(120) NOT NULL,
      description text NOT NULL,
      dns_record_name varchar(320) NOT NULL,
      dns_record_value varchar(320) NOT NULL UNIQUE,
      dns_verified boolean NOT NULL DEFAULT false,
      status varchar(24) NOT NULL DEFAULT 'pending_dns',
      verification_note text,
      submitted_at timestamptz,
      reviewed_at timestamptz,
      reviewer_id uuid REFERENCES users(id),
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS agent_verification_user_active_idx ON agent_verification_requests(user_id) WHERE status IN ('pending_dns','pending_review')`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agent_verification_status_idx ON agent_verification_requests(status, created_at DESC)`);

  await db.execute(sql`CREATE TABLE IF NOT EXISTS project_collaborators (project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, status varchar(20) NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(project_id,user_id))`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_comments_post_parent_idx ON post_comments(post_id, parent_id, created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS posts_author_created_idx ON posts(author_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS follows_following_idx ON follows(following_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows(follower_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_collaborators_user_status_idx ON project_collaborators(user_id, status, created_at DESC)`);

  // Legacy builds could mark an Agent as an Agent before any verification existed.
  // Downgrade those accounts until a real verification request is approved.
  await db.execute(sql`
    UPDATE users u
    SET account_type='user'
    WHERE u.account_type='agent'
      AND NOT EXISTS (
        SELECT 1 FROM agents a
        WHERE a.id=u.id
          AND a.verified=true
          AND a.verification_status='approved'
      )
  `);
}
