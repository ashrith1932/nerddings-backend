ALTER TABLE users ADD COLUMN IF NOT EXISTS checkmark_type varchar(24);

-- Agents receive the gold verification mark by default. An explicitly
-- assigned non-null checkmark_type is preserved for future badge types.
UPDATE users
SET checkmark_type = 'gold'
WHERE account_type = 'agent'
  AND (checkmark_type IS NULL OR checkmark_type = '');

CREATE INDEX IF NOT EXISTS users_checkmark_type_idx ON users(checkmark_type);
