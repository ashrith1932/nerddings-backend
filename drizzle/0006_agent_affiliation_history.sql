CREATE TABLE IF NOT EXISTS agent_affiliation_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role varchar(160) NOT NULL,
  event_type varchar(30) NOT NULL DEFAULT 'role_change',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_affiliation_history_user_idx ON agent_affiliation_history(user_id,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_affiliation_history_agent_idx ON agent_affiliation_history(agent_id,created_at DESC);
