CREATE TABLE IF NOT EXISTS agent_role_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  "current_role" varchar(160),
  requested_role varchar(160) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'pending',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_role_requests_agent_status_idx ON agent_role_requests(agent_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_role_requests_user_idx ON agent_role_requests(user_id,created_at DESC);
ALTER TABLE posts ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS posts_agent_id_idx ON posts(agent_id);
