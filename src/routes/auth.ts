import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { getUser, loginUser, registerUser } from "../lib/auth-store.js";

const registerSchema = z.object({ name: z.string().min(2).max(160), username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/), email: z.string().email(), password: z.string().min(8).max(120), accountType: z.enum(["user", "agent"]).default("user") });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function tokenFor(user: { id: string; accountType: "user" | "agent" }) {
  return jwt.sign({ accountType: user.accountType }, env.AUTH_SECRET, { subject: user.id, expiresIn: "7d" });
}

export const authRouter = Router();

authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please enter valid account details.", details: parsed.error.flatten() });
  try {
    const user = await registerUser(parsed.data);
    return res.status(201).json({ data: { user, token: tokenFor(user) } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "REGISTER_FAILED";
    if (code === "EMAIL_EXISTS" || code === "USERNAME_EXISTS") return res.status(409).json({ error: "That email or username is already in use." });
    return res.status(500).json({ error: "Unable to create account." });
  }
});

authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Enter your email and password." });
  try {
    const user = await loginUser(parsed.data.email, parsed.data.password);
    return res.json({ data: { user, token: tokenFor(user) } });
  } catch {
    return res.status(401).json({ error: "Email or password is incorrect." });
  }
});

authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await getUser(req.auth!.subjectId);
  if (!user) return res.status(404).json({ error: "Account not found." });
  return res.json({ data: user });
});

authRouter.post("/logout", requireAuth, (_req, res) => res.status(204).send());
