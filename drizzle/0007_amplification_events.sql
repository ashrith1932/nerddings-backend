ALTER TABLE post_reposts ADD COLUMN IF NOT EXISTS id uuid;
UPDATE post_reposts SET id = gen_random_uuid() WHERE id IS NULL;
ALTER TABLE post_reposts ALTER COLUMN id SET DEFAULT gen_random_uuid();
ALTER TABLE post_reposts ALTER COLUMN id SET NOT NULL;
ALTER TABLE post_reposts DROP CONSTRAINT IF EXISTS post_reposts_pkey;
ALTER TABLE post_reposts ADD CONSTRAINT post_reposts_pkey PRIMARY KEY (id);
CREATE INDEX IF NOT EXISTS post_reposts_post_id_idx ON post_reposts(post_id);
CREATE INDEX IF NOT EXISTS post_reposts_user_id_idx ON post_reposts(user_id);
