ALTER TABLE post_comments
  ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES post_comments(id) ON DELETE CASCADE;

ALTER TABLE posts
  ADD COLUMN IF NOT EXISTS quote_post_id uuid REFERENCES posts(id) ON DELETE SET NULL;

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS github_url text;

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS website text;

CREATE INDEX IF NOT EXISTS post_comments_post_parent_idx
  ON post_comments(post_id, parent_id, created_at);

CREATE INDEX IF NOT EXISTS posts_author_created_idx
  ON posts(author_id, created_at DESC);

CREATE INDEX IF NOT EXISTS follows_following_idx
  ON follows(following_id, created_at DESC);

CREATE INDEX IF NOT EXISTS follows_follower_idx
  ON follows(follower_id, created_at DESC);
