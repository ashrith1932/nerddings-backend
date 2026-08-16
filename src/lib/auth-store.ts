import { randomUUID } from "node:crypto";
import { db } from "../db/client.js";
import { agents, users } from "../db/schema.js";
import { eq } from "drizzle-orm";
import { hashPassword, verifyPassword } from "./security.js";

export type AuthUser = { id: string; name: string; username: string; email: string; accountType: "user" | "agent"; avatarUrl?: string | null };
type LocalUser = AuthUser & { passwordHash: string };

const localUsers = new Map<string, LocalUser>();

function publicUser(user: LocalUser): AuthUser {
  const { passwordHash: _passwordHash, ...safe } = user;
  return safe;
}

export async function registerUser(input: { name: string; username: string; email: string; password: string; accountType: "user" | "agent" }) {
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
      accountType: input.accountType,
    }).returning();
    if (!created) throw new Error("REGISTER_FAILED");
    if (input.accountType === "agent") {
      await db.insert(agents).values({ id: created.id, name: created.name, slug: created.username, type: "startup", verified: false });
    }
    return { id: created.id, name: created.name, username: created.username, email: created.email, accountType: (created.accountType === "agent" ? "agent" : "user") as "user" | "agent", avatarUrl: created.avatarUrl };
  }
  if ([...localUsers.values()].some((user) => user.email === input.email.toLowerCase())) throw new Error("EMAIL_EXISTS");
  if ([...localUsers.values()].some((user) => user.username === input.username.toLowerCase())) throw new Error("USERNAME_EXISTS");
  const user: LocalUser = { id: randomUUID(), name: input.name, username: input.username.toLowerCase(), email: input.email.toLowerCase(), accountType: input.accountType, passwordHash: await hashPassword(input.password) };
  localUsers.set(user.id, user);
  return publicUser(user);
}

export async function loginUser(email: string, password: string) {
  if (db) {
    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase())).limit(1);
    if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) throw new Error("INVALID_LOGIN");
    return { id: user.id, name: user.name, username: user.username, email: user.email, accountType: (user.accountType === "agent" ? "agent" : "user") as "user" | "agent", avatarUrl: user.avatarUrl };
  }
  const user = [...localUsers.values()].find((candidate) => candidate.email === email.toLowerCase());
  if (!user || !(await verifyPassword(password, user.passwordHash))) throw new Error("INVALID_LOGIN");
  return publicUser(user);
}

export async function getUser(id: string) {
  if (db) {
    const [user] = await db.select().from(users).where(eq(users.id, id)).limit(1);
    if (!user) return null;
    return { id: user.id, name: user.name, username: user.username, email: user.email, accountType: (user.accountType === "agent" ? "agent" : "user") as "user" | "agent", avatarUrl: user.avatarUrl };
  }
  const user = localUsers.get(id);
  return user ? publicUser(user) : null;
}
