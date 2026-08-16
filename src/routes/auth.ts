import { Router } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import { completeOnboarding, findOrCreateOAuthUser, getUser, loginUser, registerUser } from "../lib/auth-store.js";
import { createClient } from "@supabase/supabase-js";

const registerSchema = z.object({ name: z.string().min(2).max(160), username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/), email: z.string().email(), password: z.string().min(8).max(120), accountType: z.enum(["user", "agent"]).default("user") });
const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

function tokenFor(user: { id: string; accountType: "user" | "agent" }) {
  return jwt.sign({ accountType: user.accountType }, env.AUTH_SECRET, { subject: user.id, expiresIn: "7d" });
}

export const authRouter = Router();

const supabase = env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } })
  : null;

authRouter.get("/oauth/:provider", async (req, res) => {
  const provider = req.params.provider;
  if (!supabase || !["google", "github"].includes(provider)) return res.status(404).json({ error: "OAuth provider is not configured." });
  const { data, error } = await supabase.auth.signInWithOAuth({ provider: provider as "google" | "github", options: { redirectTo: `${env.BACKEND_ORIGIN.replace(/\/$/, "")}/api/v1/auth/oauth/callback` } });
  if (error || !data.url) return res.status(502).json({ error: "Unable to start OAuth sign-in." });
  return res.redirect(data.url);
});

authRouter.get("/oauth/callback", async (req, res) => {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!supabase || !code) return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_failed`);
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error || !data.user?.email) throw new Error("OAUTH_EXCHANGE_FAILED");
    const user = await findOrCreateOAuthUser({ email: data.user.email, name: data.user.user_metadata?.full_name ?? data.user.user_metadata?.name, username: data.user.user_metadata?.user_name ?? data.user.user_metadata?.preferred_username, avatarUrl: data.user.user_metadata?.avatar_url });
    return res.redirect(`${env.FRONTEND_ORIGIN}/auth/callback?token=${encodeURIComponent(tokenFor(user))}`);
  } catch {
    return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_failed`);
  }
});

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

authRouter.post("/onboarding", requireAuth, async (req, res) => {
  const parsed = z.object({ name: z.string().min(2).max(160), username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/), accountType: z.enum(["user", "agent"]), interests: z.array(z.string().min(1).max(60)).max(12).default([]) }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please complete all required onboarding details." });
  try { return res.json({ data: await completeOnboarding(req.auth!.subjectId, parsed.data) }); }
  catch (error) { if (error instanceof Error && error.message === "USERNAME_EXISTS") return res.status(409).json({ error: "That username is already in use." }); return res.status(500).json({ error: "Unable to complete onboarding." }); }
});

authRouter.post("/logout", requireAuth, (_req, res) => res.status(204).send());
