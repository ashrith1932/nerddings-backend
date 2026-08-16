CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(160) NOT NULL,
  username varchar(80) NOT NULL UNIQUE,
  email varchar(320) NOT NULL UNIQUE,
  password_hash text,
  avatar_url text,
  bio text,
  location varchar(160),
  account_type varchar(20) NOT NULL DEFAULT 'user',
  interests text[] NOT NULL DEFAULT '{}',
  onboarding_completed boolean NOT NULL DEFAULT false,
  trust_score integer NOT NULL DEFAULT 50,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(180) NOT NULL,
  slug varchar(100) NOT NULL UNIQUE, type varchar(80) NOT NULL,
  verified boolean NOT NULL DEFAULT false, verification_status varchar(20) NOT NULL DEFAULT 'pending', verification_note text, reviewed_at timestamptz, domain varchar(255), created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS onboarding_completed boolean NOT NULL DEFAULT false;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_status varchar(20) NOT NULL DEFAULT 'pending';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_note text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;
CREATE TABLE IF NOT EXISTS projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), owner_id uuid NOT NULL REFERENCES users(id), agent_id uuid REFERENCES agents(id),
  name varchar(180) NOT NULL, slug varchar(100) NOT NULL UNIQUE, description text NOT NULL, stage varchar(40) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS posts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), author_id uuid NOT NULL REFERENCES users(id), project_id uuid REFERENCES projects(id),
  body text NOT NULL, proof_of_work_score numeric(8,2) NOT NULL DEFAULT 0, meaningful_engagement_score numeric(8,2) NOT NULL DEFAULT 0,
  spam_penalty numeric(8,2) NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS post_media (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  storage_path text NOT NULL, public_url text, mime_type varchar(120) NOT NULL, width integer, height integer,
  sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS post_comments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  author_id uuid NOT NULL REFERENCES users(id), body text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS post_likes (post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS post_saves (post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS post_reposts (post_id uuid NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS follows (follower_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, following_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (follower_id, following_id));
CREATE TABLE IF NOT EXISTS conversations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS conversation_members (conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, PRIMARY KEY (conversation_id, user_id));
CREATE TABLE IF NOT EXISTS messages (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE, sender_id uuid NOT NULL REFERENCES users(id), body text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), recipient_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, actor_id uuid REFERENCES users(id), kind varchar(40) NOT NULL, entity_id text, text text NOT NULL, read_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS user_settings (user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, discoverable boolean NOT NULL DEFAULT true, email_notifications boolean NOT NULL DEFAULT true, push_notifications boolean NOT NULL DEFAULT true, allow_messages boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS fundraisings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES agents(id), startup_name varchar(180) NOT NULL,
  stage varchar(40) NOT NULL, industry varchar(80) NOT NULL, target_amount numeric(14,2) NOT NULL, raised_amount numeric(14,2) NOT NULL DEFAULT 0,
  currency varchar(4) NOT NULL DEFAULT 'INR', investor_count integer NOT NULL DEFAULT 0, visibility varchar(20) NOT NULL DEFAULT 'public', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, created_at DESC);
