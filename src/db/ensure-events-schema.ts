import { sql } from "drizzle-orm";
import { db } from "./client.js";

export async function ensureEventsSchema() {
  if (!db) return;

  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS slug varchar(220)`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS short_description varchar(500)`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS cover_image_url text`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS format varchar(20) NOT NULL DEFAULT 'in_person'`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS location_address text`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS city varchar(100)`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS country varchar(100)`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS online_url text`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS end_at timestamptz`);
  await db.execute(sql`UPDATE events SET end_at = starts_at + interval '2 hours' WHERE end_at IS NULL`);
  await db.execute(sql`ALTER TABLE events ALTER COLUMN end_at SET NOT NULL`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS timezone varchar(100) NOT NULL DEFAULT 'UTC'`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS max_attendees integer`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'published'`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS published_at timestamptz`);
  await db.execute(sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS cancelled_at timestamptz`);

  await db.execute(sql`UPDATE events SET slug = COALESCE(NULLIF(slug, ''), 'event-' || id::text) WHERE slug IS NULL OR slug = ''`);
  await db.execute(sql`CREATE UNIQUE INDEX IF NOT EXISTS events_slug_unique_idx ON events(slug) WHERE slug IS NOT NULL`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_status_idx ON events(status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_starts_at_idx ON events(starts_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_end_at_idx ON events(end_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_creator_idx ON events(creator_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_event_type_idx ON events(event_type)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_format_idx ON events(format)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS events_city_idx ON events(city)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS event_topics(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      name varchar(100) NOT NULL UNIQUE,
      slug varchar(120) NOT NULL UNIQUE,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS event_topic_map(
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      topic_id uuid NOT NULL REFERENCES event_topics(id) ON DELETE CASCADE,
      PRIMARY KEY(event_id, topic_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS event_topic_map_event_idx ON event_topic_map(event_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS event_topic_map_topic_idx ON event_topic_map(topic_id)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS event_bookmarks(
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(event_id, user_id)
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS event_bookmarks_user_idx ON event_bookmarks(user_id, created_at DESC)`);

  await db.execute(sql`ALTER TABLE event_rsvps ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()`);
  await db.execute(sql`ALTER TABLE event_rsvps ADD COLUMN IF NOT EXISTS status varchar(20) NOT NULL DEFAULT 'going'`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS event_rsvps_event_idx ON event_rsvps(event_id, status)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS event_rsvps_user_idx ON event_rsvps(user_id, created_at DESC)`);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS event_audit_log(
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id uuid NOT NULL REFERENCES events(id) ON DELETE CASCADE,
      actor_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action varchar(40) NOT NULL,
      metadata jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS event_audit_event_idx ON event_audit_log(event_id, created_at DESC)`);
}
