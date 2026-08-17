ALTER TABLE posts ADD COLUMN IF NOT EXISTS link_url text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS github_url text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS website text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_status varchar(20) NOT NULL DEFAULT 'pending';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS verification_note text;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS reviewed_at timestamptz;

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
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_verification_user_active_idx
  ON agent_verification_requests(user_id)
  WHERE status IN ('pending_dns','pending_review');
CREATE INDEX IF NOT EXISTS agent_verification_status_idx
  ON agent_verification_requests(status, created_at DESC);

UPDATE users u
SET account_type='user'
WHERE u.account_type='agent'
  AND NOT EXISTS (
    SELECT 1 FROM agents a
    WHERE a.id=u.id
      AND a.verified=true
      AND a.verification_status='approved'
  );
