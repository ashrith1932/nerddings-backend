import { sql } from "drizzle-orm";
import { db } from "./client.js";

export async function ensureSocialSchema() {
  if (!db) return;

  await db.execute(sql`ALTER TABLE post_comments ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES post_comments(id) ON DELETE CASCADE`);
  await db.execute(sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS quote_post_id uuid REFERENCES posts(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_url text`);
  await db.execute(sql`ALTER TABLE posts ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL`);
  await db.execute(sql`ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_url text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS website text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_status varchar(20) NOT NULL DEFAULT 'pending'`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_note text`);
  await db.execute(sql`ALTER TABLE agents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_url text`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_logo_url text`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_position_x integer NOT NULL DEFAULT 50`);
  await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_position_y integer NOT NULL DEFAULT 50`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_verification_requests(
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
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agent_verification_status_idx ON agent_verification_requests(status,created_at DESC)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS follows(
      follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      following_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(follower_id,following_id),
      CHECK(follower_id<>following_id)
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS project_collaborators(
      project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status varchar(20) NOT NULL DEFAULT 'pending',
      role varchar(20) NOT NULL DEFAULT 'editor',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(project_id,user_id)
    )
  `);
  await db.execute(sql`ALTER TABLE project_collaborators ADD COLUMN IF NOT EXISTS role varchar(20) NOT NULL DEFAULT 'editor'`);
  await db.execute(sql`UPDATE project_collaborators pc SET role='owner' FROM projects p WHERE p.id=pc.project_id AND p.owner_id=pc.user_id`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_collaborators_user_status_idx ON project_collaborators(user_id,status,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS project_collaborators_project_status_idx ON project_collaborators(project_id,status,created_at DESC)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_affiliation_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role varchar(160) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(agent_id,user_id)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_affiliations(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role varchar(160) NOT NULL,
      verified_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(agent_id,user_id)
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_role_requests(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "current_role" varchar(160),
      requested_role varchar(160) NOT NULL,
      status varchar(20) NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS agent_affiliation_history(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role varchar(160) NOT NULL,
      event_type varchar(30) NOT NULL DEFAULT 'role_change',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS hashtags(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tag varchar(64) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`ALTER TABLE hashtags ADD COLUMN IF NOT EXISTS tag varchar(64)`);
  await db.execute(sql`
    UPDATE hashtags
    SET tag = COALESCE(
      NULLIF(to_jsonb(hashtags)->>'tag', ''),
      NULLIF(to_jsonb(hashtags)->>'name', ''),
      NULLIF(to_jsonb(hashtags)->>'slug', '')
    )
    WHERE tag IS NULL
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS hashtags_tag_idx ON hashtags(tag)`);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS post_hashtags(
      post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      hashtag_id uuid NOT NULL REFERENCES hashtags(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(post_id,hashtag_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_hashtags_tag_idx ON post_hashtags(hashtag_id,post_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_hashtags_post_idx ON post_hashtags(post_id,hashtag_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS post_views(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(post_id,user_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_views_post_idx ON post_views(post_id,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_views_user_idx ON post_views(user_id,created_at DESC)`);

  await db.execute(sql`CREATE INDEX IF NOT EXISTS post_comments_post_parent_idx ON post_comments(post_id,parent_id,created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS posts_author_created_idx ON posts(author_id,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS posts_agent_id_idx ON posts(agent_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS follows_following_idx ON follows(following_id,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS follows_follower_idx ON follows(follower_id,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agent_affiliation_requests_agent_status_idx ON agent_affiliation_requests(agent_id,status,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agent_affiliations_user_idx ON agent_affiliations(user_id,verified_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agent_role_requests_agent_status_idx ON agent_role_requests(agent_id,status,created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS agent_affiliation_history_user_idx ON agent_affiliation_history(user_id,created_at DESC)`);
}
