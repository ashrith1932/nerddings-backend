import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { createServerClient } from "@supabase/ssr";

import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";

import {
  completeOnboarding,
  findOrCreateOAuthUser,
  getUser,
  loginUser,
  registerUser,
} from "../lib/auth-store.js";

const registerSchema = z.object({
  name: z.string().min(2).max(160),
  username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/),
  email: z.string().email(),
  password: z.string().min(8).max(120),
  accountType: z.enum(["user", "agent"]).default("user"),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function tokenFor(user: { id: string; accountType: "user" | "agent" }) {
  return jwt.sign({ accountType: user.accountType }, env.AUTH_SECRET, { subject: user.id, expiresIn: "7d" });
}

function getCookies(req: Request) {
  const header = req.headers.cookie;
  if (!header) return [];
  return header.split(";").map((part) => {
    const index = part.indexOf("=");
    if (index === -1) return null;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    try { return { name, value: decodeURIComponent(value) }; }
    catch { return { name, value }; }
  }).filter((cookie): cookie is { name: string; value: string } => cookie !== null);
}

function serializeCookie(name: string, value: string, options: Record<string, unknown> = {}) {
  let cookie = `${name}=${encodeURIComponent(value)}`;
  cookie += `; Path=${typeof options.path === "string" ? options.path : "/"}`;
  if (typeof options.maxAge === "number") cookie += `; Max-Age=${Math.floor(options.maxAge)}`;
  if (options.domain) cookie += `; Domain=${options.domain}`;
  if (options.httpOnly !== false) cookie += "; HttpOnly";
  if (options.secure !== false) cookie += "; Secure";
  if (options.sameSite) {
    const sameSite = String(options.sameSite);
    cookie += `; SameSite=${sameSite.charAt(0).toUpperCase()}${sameSite.slice(1)}`;
  } else cookie += "; SameSite=Lax";
  if (options.expires instanceof Date) cookie += `; Expires=${options.expires.toUTCString()}`;
  return cookie;
}

type PendingCookie = { name: string; value: string; options: Record<string, unknown> };
type PendingHeaders = Record<string, string | string[]>;

function createSupabaseServerClient(req: Request, res: Response) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return null;
  const pendingCookies: PendingCookie[] = [];
  const pendingHeaders: PendingHeaders = {};
  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    cookies: {
      getAll() { return getCookies(req); },
      setAll(cookiesToSet, headers) {
        for (const { name, value, options } of cookiesToSet) pendingCookies.push({ name, value, options: options as Record<string, unknown> });
        if (headers) for (const [key, value] of Object.entries(headers)) pendingHeaders[key] = value;
      },
    },
  });
  function flushResponseHeaders() {
    if (res.headersSent) return;
    for (const cookie of pendingCookies) res.append("Set-Cookie", serializeCookie(cookie.name, cookie.value, cookie.options));
    for (const [key, value] of Object.entries(pendingHeaders)) res.setHeader(key, value);
  }
  return { supabase, flushResponseHeaders };
}

export const authRouter = Router();

authRouter.get("/oauth/callback", async (req, res) => {
  console.log("[OAuth] Callback received:", req.originalUrl);
  const code = typeof req.query.code === "string" ? req.query.code : "";
  if (!code) return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_code_missing`);
  const client = createSupabaseServerClient(req, res);
  if (!client) return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_not_configured`);
  const { supabase, flushResponseHeaders } = client;

  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_exchange_failed`);
    const oauthUser = data.user;
    if (!oauthUser?.email) return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_user_missing`);

    const user = await findOrCreateOAuthUser({
      email: oauthUser.email,
      name: oauthUser.user_metadata?.full_name ?? oauthUser.user_metadata?.name ?? null,
      username: oauthUser.user_metadata?.user_name ?? oauthUser.user_metadata?.preferred_username ?? null,
      avatarUrl: oauthUser.user_metadata?.avatar_url ?? null,
    });

    const token = tokenFor(user);
    flushResponseHeaders();
    return res.redirect(`${env.FRONTEND_ORIGIN}/auth/callback?token=${encodeURIComponent(token)}`);
  } catch (error) {
    console.error("[OAuth] Callback exception:", error);
    if (!res.headersSent) return res.redirect(`${env.FRONTEND_ORIGIN}/login?error=oauth_failed`);
    return;
  }
});

authRouter.get("/oauth/:provider", async (req, res) => {
  const provider = req.params.provider;
  if (provider !== "github" && provider !== "google") return res.status(404).json({ error: "Unsupported OAuth provider." });
  const client = createSupabaseServerClient(req, res);
  if (!client) return res.status(500).json({ error: "Supabase OAuth is not configured." });
  const { supabase, flushResponseHeaders } = client;
  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: provider as "github" | "google",
      options: { redirectTo: `${env.BACKEND_ORIGIN.replace(/\/$/, "")}/api/v1/auth/oauth/callback` },
    });
    if (error || !data.url) return res.status(502).json({ error: "Unable to start OAuth sign-in." });
    flushResponseHeaders();
    return res.redirect(data.url);
  } catch (error) {
    console.error("[OAuth] OAuth start exception:", error);
    if (!res.headersSent) return res.status(500).json({ error: "Unable to start OAuth sign-in." });
    return;
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
    if (code === "AGENT_APPLICATION_REQUIRED") return res.status(400).json({ error: "Agent accounts must complete organization and domain verification before becoming an Agent." });
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
  const parsed = z.object({
    name: z.string().min(2).max(160),
    username: z.string().regex(/^[a-zA-Z0-9_.-]{3,40}$/),
    accountType: z.enum(["user", "agent"]),
    interests: z.array(z.string().min(1).max(60)).max(12).default([]),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Please complete all required onboarding details." });
  if (parsed.data.accountType === "agent") return res.status(409).json({ error: "Agent verification must be completed through the organization verification flow." });

  try {
    const user = await completeOnboarding(req.auth!.subjectId, parsed.data);
    return res.json({ data: user });
  } catch (error) {
    if (error instanceof Error && error.message === "USERNAME_EXISTS") return res.status(409).json({ error: "That username is already in use." });
    return res.status(500).json({ error: "Unable to complete onboarding." });
  }
});
