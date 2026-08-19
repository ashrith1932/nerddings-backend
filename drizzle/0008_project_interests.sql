CREATE TABLE IF NOT EXISTS project_interests (
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_interests_user_created_idx
  ON project_interests(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS project_interests_project_created_idx
  ON project_interests(project_id, created_at DESC);
