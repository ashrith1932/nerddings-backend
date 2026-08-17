ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_logo_url text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_position_x integer NOT NULL DEFAULT 50;
ALTER TABLE users ADD COLUMN IF NOT EXISTS cover_position_y integer NOT NULL DEFAULT 50;
CREATE TABLE IF NOT EXISTS agent_affiliation_requests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role varchar(160) NOT NULL, status varchar(20) NOT NULL DEFAULT 'pending', created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(agent_id,user_id));
CREATE TABLE IF NOT EXISTS agent_affiliations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, role varchar(160) NOT NULL, verified_at timestamptz NOT NULL DEFAULT now(), UNIQUE(agent_id,user_id));
CREATE INDEX IF NOT EXISTS agent_affiliation_requests_agent_status_idx ON agent_affiliation_requests(agent_id,status,created_at DESC);
CREATE INDEX IF NOT EXISTS agent_affiliations_user_idx ON agent_affiliations(user_id,verified_at DESC);
