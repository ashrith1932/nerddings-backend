import { Router, type Request, type Response } from "express";
import jwt from "jsonwebtoken";
import { z } from "zod";
import { env } from "../config/env.js";
import { requireAuth } from "../middleware/auth.js";
import {
  completeOnboarding,
  findOrCreateOAuthUser,
  getUser,
  loginUser,
  registerUser,
} from "../lib/auth-store.js";
import { createClient, type SupportedStorage } from "@supabase/supabase-js";

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
  return jwt.sign(
    {
      accountType: user.accountType,
    },
    env.AUTH_SECRET,
    {
      subject: user.id,
      expiresIn: "7d",
    },
  );
}

/*
 * ---------------------------------------------------------
 * Cookie helpers for Supabase PKCE
 * ---------------------------------------------------------
 *
 * Supabase creates a PKCE code verifier when OAuth starts.
 * Because the OAuth callback happens in a new HTTP request,
 * the verifier must survive between the two requests.
 *
 * We store it in an HttpOnly cookie.
 */

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;

  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};

  for (const part of header.split(";")) {
    const separatorIndex = part.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = part.slice(0, separatorIndex).trim();
    const value = part.slice(separatorIndex + 1).trim();

    try {
      cookies[key] = decodeURIComponent(value);
    } catch {
      cookies[key] = value;
    }
  }

  return cookies;
}

function setCookie(
  res: Response,
  name: string,
  value: string,
  maxAgeSeconds = 600,
) {
  const cookie = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/api/v1/auth",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ].join("; ");

  res.append("Set-Cookie", cookie);
}

function clearCookie(res: Response, name: string) {
  const cookie = [
    `${name}=`,
    "Path=/api/v1/auth",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    "Max-Age=0",
  ].join("; ");

  res.append("Set-Cookie", cookie);
}

/*
 * Creates a Supabase client for THIS request.
 *
 * Important:
 * We do not keep one Supabase client globally because
 * the PKCE verifier belongs to a particular browser session.
 */
function createSupabaseClient(req: Request, res: Response) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    return null;
  }

  const incomingCookies = parseCookies(req);

  const storage: SupportedStorage = {
    getItem: (key) => {
      return incomingCookies[key] ?? null;
    },

    setItem: (key, value) => {
      /*
       * Supabase uses this to store the PKCE verifier.
       */
      setCookie(res, key, value);
    },

    removeItem: (key) => {
      clearCookie(res, key);
    },
  };

  return createClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      auth: {
        flowType: "pkce",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
        storage,
      },
    },
  );
}

export const authRouter = Router();

/*
 * ---------------------------------------------------------
 * OAuth START
 * ---------------------------------------------------------
 *
 * Examples:
 *
 * GET /api/v1/auth/oauth/github
 * GET /api/v1/auth/oauth/google
 */
authRouter.get("/oauth/:provider", async (req, res) => {
  const provider = req.params.provider;

  if (provider !== "google" && provider !== "github") {
    return res.status(404).json({
      error: "Unsupported OAuth provider.",
    });
  }

  const supabase = createSupabaseClient(req, res);

  if (!supabase) {
    return res.status(500).json({
      error: "Supabase OAuth is not configured.",
    });
  }

  try {
    const { data, error } = await supabase.auth.signInWithOAuth({
      provider,
      options: {
        redirectTo:
          `${env.BACKEND_ORIGIN.replace(/\/$/, "")}/api/v1/auth/oauth/callback`,
      },
    });

    if (error || !data.url) {
      console.error("OAuth start error:", error);

      return res.status(502).json({
        error: "Unable to start OAuth sign-in.",
      });
    }

    return res.redirect(data.url);
  } catch (error) {
    console.error("OAuth start exception:", error);

    return res.status(500).json({
      error: "Unable to start OAuth sign-in.",
    });
  }
});

/*
 * ---------------------------------------------------------
 * OAuth CALLBACK
 * ---------------------------------------------------------
 *
 * Supabase PKCE redirects here with:
 *
 * /api/v1/auth/oauth/callback?code=xxxxx
 *
 * NOT:
 *
 * /api/v1/auth/oauth/callback#access_token=xxxxx
 */
authRouter.get("/oauth/callback", async (req, res) => {
  const code =
    typeof req.query.code === "string"
      ? req.query.code
      : "";

  if (!code) {
    return res.redirect(
      `${env.FRONTEND_ORIGIN}/login?error=oauth_code_missing`,
    );
  }

  const supabase = createSupabaseClient(req, res);

  if (!supabase) {
    return res.redirect(
      `${env.FRONTEND_ORIGIN}/login?error=oauth_not_configured`,
    );
  }

  try {
    /*
     * The Supabase client reads the PKCE verifier from
     * the HttpOnly cookie created during OAuth start.
     */
    const { data, error } =
      await supabase.auth.exchangeCodeForSession(code);

    if (error) {
      console.error("OAuth code exchange error:", error);

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_exchange_failed`,
      );
    }

    if (!data.user?.email) {
      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_user_missing`,
      );
    }

    /*
     * Create/find the corresponding Nerddings user.
     */
    const user = await findOrCreateOAuthUser({
      email: data.user.email,
      name:
        data.user.user_metadata?.full_name ??
        data.user.user_metadata?.name,
      username:
        data.user.user_metadata?.user_name ??
        data.user.user_metadata?.preferred_username,
      avatarUrl:
        data.user.user_metadata?.avatar_url,
    });

    /*
     * Remove the temporary PKCE verifier cookie.
     *
     * Supabase calls removeItem() during the exchange,
     * but clearing the cookie here as well is harmless and
     * makes the intent explicit.
     */
    const cookies = parseCookies(req);

    for (const key of Object.keys(cookies)) {
      if (
        key.includes("code-verifier") ||
        key.includes("code_verifier")
      ) {
        clearCookie(res, key);
      }
    }

    /*
     * Your application continues using its own JWT.
     */
    const token = tokenFor(user);

    return res.redirect(
      `${env.FRONTEND_ORIGIN}/auth/callback?token=${encodeURIComponent(token)}`,
    );
  } catch (error) {
    console.error("OAuth callback exception:", error);

    return res.redirect(
      `${env.FRONTEND_ORIGIN}/login?error=oauth_failed`,
    );
  }
});

/*
 * ---------------------------------------------------------
 * NORMAL EMAIL/PASSWORD REGISTRATION
 * ---------------------------------------------------------
 */
authRouter.post("/register", async (req, res) => {
  const parsed = registerSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Please enter valid account details.",
      details: parsed.error.flatten(),
    });
  }

  try {
    const user = await registerUser(parsed.data);

    return res.status(201).json({
      data: {
        user,
        token: tokenFor(user),
      },
    });
  } catch (error) {
    const code =
      error instanceof Error
        ? error.message
        : "REGISTER_FAILED";

    if (
      code === "EMAIL_EXISTS" ||
      code === "USERNAME_EXISTS"
    ) {
      return res.status(409).json({
        error: "That email or username is already in use.",
      });
    }

    return res.status(500).json({
      error: "Unable to create account.",
    });
  }
});

/*
 * ---------------------------------------------------------
 * NORMAL EMAIL/PASSWORD LOGIN
 * ---------------------------------------------------------
 */
authRouter.post("/login", async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Enter your email and password.",
    });
  }

  try {
    const user = await loginUser(
      parsed.data.email,
      parsed.data.password,
    );

    return res.json({
      data: {
        user,
        token: tokenFor(user),
      },
    });
  } catch {
    return res.status(401).json({
      error: "Email or password is incorrect.",
    });
  }
});

/*
 * ---------------------------------------------------------
 * CURRENT USER
 * ---------------------------------------------------------
 */
authRouter.get("/me", requireAuth, async (req, res) => {
  const user = await getUser(req.auth!.subjectId);

  if (!user) {
    return res.status(404).json({
      error: "Account not found.",
    });
  }

  return res.json({
    data: user,
  });
});

/*
 * ---------------------------------------------------------
 * ONBOARDING
 * ---------------------------------------------------------
 */
authRouter.post("/onboarding", requireAuth, async (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(2).max(160),
      username: z
        .string()
        .regex(/^[a-zA-Z0-9_.-]{3,40}$/),
      accountType: z.enum(["user", "agent"]),
      interests: z
        .array(z.string().min(1).max(60))
        .max(12)
        .default([]),
    })
    .safeParse(req.body);

  if (!parsed.success) {
    return res.status(400).json({
      error: "Please complete all required onboarding details.",
    });
  }

  try {
    return res.json({
      data: await completeOnboarding(
        req.auth!.subjectId,
        parsed.data,
      ),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "USERNAME_EXISTS"
    ) {
      return res.status(409).json({
        error: "That username is already in use.",
      });
    }

    return res.status(500).json({
      error: "Unable to complete onboarding.",
    });
  }
});

/*
 * ---------------------------------------------------------
 * LOGOUT
 * ---------------------------------------------------------
 */
authRouter.post(
  "/logout",
  requireAuth,
  (_req, res) => res.status(204).send(),
);