import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { hashPassword, verifyPassword } from "./security.js";

export type AuthUser = {
  id: string;
  name: string;
  username: string;
  email: string;
  accountType: "user" | "agent";
  avatarUrl?: string | null;
  onboardingCompleted: boolean;
  agentVerificationStatus?: "pending_dns" | "pending_review" | "approved" | "rejected" | null;
  agentVerificationId?: string | null;
};

type LocalUser = AuthUser & { passwordHash: string };
type VerificationRow = { id: string; status: AuthUser["agentVerificationStatus"] };

const localUsers = new Map<string, LocalUser>();

async function verificationFor(userId: string): Promise<VerificationRow | null> {
  if (!db) return null;
  const rows = await db.execute(sql`
    SELECT id, status
    FROM agent_verification_requests
    WHERE user_id=${userId}
    ORDER BY created_at DESC
    LIMIT 1
  `) as unknown as VerificationRow[];
  return rows[0] ?? null;
}

async function authUserFromDb(user: any): Promise<AuthUser> {
  const verification = await verificationFor(user.id);
  const approved = user.accountType === "agent" && verification?.status !== "rejected";

  return {
    id: user.id,
    name: user.name,
    username: user.username,
    email: user.email,
    accountType: (approved ? "agent" : "user") as "user" | "agent",
    avatarUrl: user.avatarUrl,
    onboardingCompleted: user.onboardingCompleted,
    agentVerificationStatus: verification?.status ?? null,
    agentVerificationId: verification?.id ?? null,
  };
}

function publicUser(user: LocalUser): AuthUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export async function registerUser(input: { name: string; username: string; email: string; password: string; accountType: "user" | "agent" }) {
  if (input.accountType === "agent") throw new Error("AGENT_APPLICATION_REQUIRED");

  if (db) {
    const existing = await db.select().from(users).where(eq(users.email, input.email.toLowerCase())).limit(1);
    if (existing[0]) throw new Error("EMAIL_EXISTS");
    const usernameExisting = await db.select().from(users).where(eq(users.username, input.username.toLowerCase())).limit(1);
    if (usernameExisting[0]) throw new Error("USERNAME_EXISTS");
    const [created] = await db.insert(users).values({
      name: input.name,
      username: input.username.toLowerCase(),
      email: input.email.toLowerCase(),
      passwordHash: await hashPassword(input.password),
      accountType: "user",
    }).returning();
    if (!created) throw new Error("REGISTER_FAILED");
    return authUserFromDb(created);
  }

  if ([...localUsers.values()].some((user) => user.email === input.email.toLowerCase())) throw new Error("EMAIL_EXISTS");
  if ([...localUsers.values()].some((user) => user.username === input.username.toLowerCase())) throw new Error("USERNAME_EXISTS");
  const user: LocalUser = {
    id: randomUUID(),
    name: input.name,
    username: input.username.toLowerCase(),
    email: input.email.toLowerCase(),
    accountType: "user",
    passwordHash: await hashPassword(input.password),
    onboardingCompleted: true,
    agentVerificationStatus: null,
    agentVerificationId: null,
  };
  localUsers.set(user.id, user);
  return publicUser(user);
}

export async function loginUser(email: string, password: string) {
  if (db) {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) throw new Error("INVALID_LOGIN");
    return authUserFromDb(user);
  }
  const user = [...localUsers.values()].find((candidate) => candidate.email === email.toLowerCase());
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new Error("INVALID_LOGIN");
  return publicUser(user);
}

export async function getUser(id: string) {
  if (db) {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return null;
    return authUserFromDb(user);
  }
  const user = localUsers.get(id);
  return user ? publicUser(user) : null;
}

export async function findOrCreateOAuthUser(input: { email: string; name?: string | null; username?: string | null; avatarUrl?: string | null }) {
  const email = input.email.toLowerCase();
  const baseUsername = (input.username ?? input.name ?? email.split("@")[0] ?? "builder")
    .toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 34) || "builder";
  const name = (input.name?.trim() || baseUsername).slice(0, 160);

  if (db) {
    const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing) return authUserFromDb(existing);
    let username = baseUsername;
    for (let suffix = 2; ; suffix += 1) {
      const [collision] = await db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1);
      if (!collision) break;
      username = `${baseUsername.slice(0, 33 - String(suffix).length)}-${suffix}`;
    }
    const [created] = await db.insert(users).values({
      name,
      username,
      email,
      avatarUrl: input.avatarUrl ?? null,
      onboardingCompleted: false,
      accountType: "user",
    }).returning();
    if (!created) throw new Error("OAUTH_USER_CREATE_FAILED");
    return authUserFromDb(created);
  }

  const existing = [...localUsers.values()].find((user) => user.email === email);
  if (existing) return publicUser(existing);
  let username = baseUsername;
  let suffix = 2;
  while ([...localUsers.values()].some((user) => user.username === username)) username = `${baseUsername}-${suffix++}`;
  const user: LocalUser = {
    id: randomUUID(),
    name,
    username,
    email,
    accountType: "user",
    passwordHash: "",
    avatarUrl: input.avatarUrl ?? null,
    onboardingCompleted: false,
    agentVerificationStatus: null,
    agentVerificationId: null,
  };
  localUsers.set(user.id, user);
  return publicUser(user);
}

export async function completeOnboarding(userId: string, input: { name: string; username: string; accountType: "user" | "agent"; interests: string[] }) {
  if (input.accountType === "agent") throw new Error("AGENT_APPLICATION_REQUIRED");

  if (db) {
    const [collision] = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username.toLowerCase())).limit(1);
    if (collision && collision.id !== userId) throw new Error("USERNAME_EXISTS");
    const [updated] = await db.update(users).set({ name: input.name, username: input.username.toLowerCase(), accountType: "user", interests: input.interests, onboardingCompleted: true }).where(eq(users.id, userId)).returning();
    if (!updated) throw new Error("ONBOARDING_FAILED");
    return authUserFromDb(updated);
  }

  const user = localUsers.get(userId);
  if (!user) throw new Error("ONBOARDING_FAILED");
  user.name = input.name;
  user.username = input.username.toLowerCase();
  user.accountType = "user";
  user.onboardingCompleted = true;
  return publicUser(user);
}
