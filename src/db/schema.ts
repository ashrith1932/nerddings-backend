import { boolean, integer, numeric, pgTable, primaryKey, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 160 }).notNull(),
  username: varchar("username", { length: 80 }).notNull().unique(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: text("password_hash"),
  avatarUrl: text("avatar_url"),
  messagingPublicKey: text("messaging_public_key"),
  messagingKeyVersion: integer("messaging_key_version").notNull().default(1),
  bio: text("bio"),
  location: varchar("location", { length: 160 }),
  accountType: varchar("account_type", { length: 20 }).notNull().default("user"),
  interests: text("interests").array().notNull().default([]),
  onboardingCompleted: boolean("onboarding_completed").notNull().default(false),
  trustScore: integer("trust_score").notNull().default(50),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const agents = pgTable("agents", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 180 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  type: varchar("type", { length: 80 }).notNull(),
  verified: boolean("verified").notNull().default(false),
  verificationStatus: varchar("verification_status", { length: 20 }).notNull().default("pending"),
  verificationNote: text("verification_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  domain: varchar("domain", { length: 255 }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const projects = pgTable("projects", {
  id: uuid("id").defaultRandom().primaryKey(),
  ownerId: uuid("owner_id").references(() => users.id).notNull(),
  agentId: uuid("agent_id").references(() => agents.id),
  name: varchar("name", { length: 180 }).notNull(),
  slug: varchar("slug", { length: 100 }).notNull().unique(),
  description: text("description").notNull(),
  stage: varchar("stage", { length: 40 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const posts = pgTable("posts", {
  id: uuid("id").defaultRandom().primaryKey(),
  authorId: uuid("author_id").references(() => users.id).notNull(),
  projectId: uuid("project_id").references(() => projects.id),
  body: text("body").notNull(),
  proofOfWorkScore: numeric("proof_of_work_score", { precision: 8, scale: 2 }).notNull().default("0"),
  meaningfulEngagementScore: numeric("meaningful_engagement_score", { precision: 8, scale: 2 }).notNull().default("0"),
  spamPenalty: numeric("spam_penalty", { precision: 8, scale: 2 }).notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const postMedia = pgTable("post_media", {
  id: uuid("id").defaultRandom().primaryKey(),
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }).notNull(),
  storagePath: text("storage_path").notNull(),
  publicUrl: text("public_url"),
  mimeType: varchar("mime_type", { length: 120 }).notNull(),
  width: integer("width"),
  height: integer("height"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const postComments = pgTable("post_comments", {
  id: uuid("id").defaultRandom().primaryKey(),
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }).notNull(),
  authorId: uuid("author_id").references(() => users.id).notNull(),
  body: text("body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const postLikes = pgTable("post_likes", {
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.postId, table.userId] }) }));

export const postSaves = pgTable("post_saves", {
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.postId, table.userId] }) }));

export const postReposts = pgTable("post_reposts", {
  postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.postId, table.userId] }) }));

export const follows = pgTable("follows", {
  followerId: uuid("follower_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  followingId: uuid("following_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.followerId, table.followingId] }) }));

export const conversations = pgTable("conversations", {
  id: uuid("id").defaultRandom().primaryKey(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const conversationMembers = pgTable("conversation_members", {
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.conversationId, table.userId] }) }));

export const messages = pgTable("messages", {
  id: uuid("id").defaultRandom().primaryKey(),

  conversationId: uuid("conversation_id")
    .references(() => conversations.id, {
      onDelete: "cascade",
    })
    .notNull(),

  senderId: uuid("sender_id")
    .references(() => users.id)
    .notNull(),

  body: text("body").notNull(),

  ciphertext: text("ciphertext"),
  iv: text("iv"),

  senderKey: text("sender_key"),
  recipientKey: text("recipient_key"),

  encryptionVersion: integer("encryption_version")
    .notNull()
    .default(1),

  /*
   * Message reached recipient's realtime client.
   */
  deliveredAt: timestamp("delivered_at", {
    withTimezone: true,
  }),

  /*
   * Recipient actually opened/read it.
   */
  readAt: timestamp("read_at", {
    withTimezone: true,
  }),

  createdAt: timestamp("created_at", {
    withTimezone: true,
  })
    .defaultNow()
    .notNull(),
});

export const messageRequests = pgTable("message_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  senderId: uuid("sender_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  recipientId: uuid("recipient_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("pending"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  recipientId: uuid("recipient_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  actorId: uuid("actor_id").references(() => users.id),
  kind: varchar("kind", { length: 40 }).notNull(),
  entityId: text("entity_id"),
  text: text("text").notNull(),
  readAt: timestamp("read_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const userSettings = pgTable("user_settings", {
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).primaryKey(),
  discoverable: boolean("discoverable").notNull().default(true),
  emailNotifications: boolean("email_notifications").notNull().default(true),
  pushNotifications: boolean("push_notifications").notNull().default(true),
  allowMessages: boolean("allow_messages").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const events = pgTable("events", {
  id: uuid("id").defaultRandom().primaryKey(),
  creatorId: uuid("creator_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  title: varchar("title", { length: 180 }).notNull(),
  description: text("description").notNull(),
  eventType: varchar("event_type", { length: 40 }).notNull().default("Community"),
  startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
  location: varchar("location", { length: 180 }).notNull(),
  url: text("url"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const eventRsvps = pgTable("event_rsvps", {
  eventId: uuid("event_id").references(() => events.id, { onDelete: "cascade" }).notNull(),
  userId: uuid("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  status: varchar("status", { length: 20 }).notNull().default("interested"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => ({ pk: primaryKey({ columns: [table.eventId, table.userId] }) }));

export const fundraisings = pgTable("fundraisings", {
  id: uuid("id").defaultRandom().primaryKey(),
  agentId: uuid("agent_id").references(() => agents.id).notNull(),
  startupName: varchar("startup_name", { length: 180 }).notNull(),
  stage: varchar("stage", { length: 40 }).notNull(),
  industry: varchar("industry", { length: 80 }).notNull(),
  targetAmount: numeric("target_amount", { precision: 14, scale: 2 }).notNull(),
  raisedAmount: numeric("raised_amount", { precision: 14, scale: 2 }).notNull().default("0"),
  currency: varchar("currency", { length: 4 }).notNull().default("INR"),
  investorCount: integer("investor_count").notNull().default(0),
  visibility: varchar("visibility", { length: 20 }).notNull().default("public"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
