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
import {
  createClient,
  type SupportedStorage,
} from "@supabase/supabase-js";

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

function tokenFor(user: {
  id: string;
  accountType: "user" | "agent";
}) {
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
 * COOKIE HELPERS
 * ---------------------------------------------------------
 */

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;

  if (!header) {
    return {};
  }

  const cookies: Record<string, string> = {};

  for (const part of header.split(";")) {
    const index = part.indexOf("=");

    if (index === -1) {
      continue;
    }

    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();

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
) {
  res.append(
    "Set-Cookie",
    [
      `${name}=${encodeURIComponent(value)}`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Max-Age=600",
    ].join("; "),
  );
}

function clearCookie(
  res: Response,
  name: string,
) {
  res.append(
    "Set-Cookie",
    [
      `${name}=`,
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=None",
      "Max-Age=0",
    ].join("; "),
  );
}

/*
 * ---------------------------------------------------------
 * SUPABASE CLIENT
 * ---------------------------------------------------------
 *
 * We create a request-specific client.
 *
 * The important part is the custom storage adapter.
 * Supabase stores the PKCE verifier through setItem().
 *
 * We put that verifier into an HttpOnly cookie.
 *
 * When the browser returns to /oauth/callback,
 * the same cookie is read through getItem().
 */

function createSupabaseClient(
  req: Request,
  res: Response,
) {
  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  const cookies = parseCookies(req);

  const storage: SupportedStorage = {
    getItem(key) {
      const value = cookies[key];

      console.log(
        `[OAuth] PKCE getItem: ${key} -> ${
          value ? "FOUND" : "NOT FOUND"
        }`,
      );

      return value ?? null;
    },

    setItem(key, value) {
      console.log(
        `[OAuth] PKCE setItem: ${key}`,
      );

      setCookie(res, key, value);
    },

    removeItem(key) {
      console.log(
        `[OAuth] PKCE removeItem: ${key}`,
      );

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
 * =========================================================
 * OAUTH CALLBACK
 * =========================================================
 *
 * IMPORTANT:
 * This MUST appear before /oauth/:provider.
 *
 * Otherwise Express interprets "callback" as the provider.
 */

authRouter.get(
  "/oauth/callback",
  async (req, res) => {
    console.log(
      "[OAuth] Callback received:",
      req.originalUrl,
    );

    const code =
      typeof req.query.code === "string"
        ? req.query.code
        : "";

    if (!code) {
      console.error(
        "[OAuth] No authorization code received.",
      );

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_code_missing`,
      );
    }

    const supabase =
      createSupabaseClient(req, res);

    if (!supabase) {
      console.error(
        "[OAuth] Supabase is not configured.",
      );

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_not_configured`,
      );
    }

    try {
      console.log(
        "[OAuth] Exchanging authorization code...",
      );

      const {
        data,
        error,
      } =
        await supabase.auth.exchangeCodeForSession(
          code,
        );

      if (error) {
        console.error(
          "[OAuth] Code exchange failed:",
          error,
        );

        return res.redirect(
          `${env.FRONTEND_ORIGIN}/login?error=oauth_exchange_failed`,
        );
      }

      if (!data.user?.email) {
        console.error(
          "[OAuth] Supabase returned no user email.",
        );

        return res.redirect(
          `${env.FRONTEND_ORIGIN}/login?error=oauth_user_missing`,
        );
      }

      console.log(
        "[OAuth] Supabase authentication successful:",
        data.user.email,
      );

      const user =
        await findOrCreateOAuthUser({
          email: data.user.email,
          name:
            data.user.user_metadata
              ?.full_name ??
            data.user.user_metadata
              ?.name,

          username:
            data.user.user_metadata
              ?.user_name ??
            data.user.user_metadata
              ?.preferred_username,

          avatarUrl:
            data.user.user_metadata
              ?.avatar_url,
        });

      const token = tokenFor(user);

      console.log(
        "[OAuth] Nerddings user authenticated:",
        user.username,
      );

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/auth/callback?token=${encodeURIComponent(
          token,
        )}`,
      );
    } catch (error) {
      console.error(
        "[OAuth] Callback exception:",
        error,
      );

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_failed`,
      );
    }
  },
);

/*
 * =========================================================
 * OAUTH START
 * =========================================================
 *
 * Supports:
 *
 * /api/v1/auth/oauth/github
 * /api/v1/auth/oauth/google
 */

authRouter.get(
  "/oauth/:provider",
  async (req, res) => {
    const provider = req.params.provider;

    if (
      provider !== "github" &&
      provider !== "google"
    ) {
      return res.status(404).json({
        error: "Unsupported OAuth provider.",
      });
    }

    const supabase =
      createSupabaseClient(req, res);

    if (!supabase) {
      console.error(
        "[OAuth] Supabase environment variables missing.",
      );

      return res.status(500).json({
        error:
          "Supabase OAuth is not configured.",
      });
    }

    try {
      console.log(
        `[OAuth] Starting ${provider} OAuth...`,
      );

      const {
        data,
        error,
      } =
        await supabase.auth.signInWithOAuth({
          provider:
            provider as "github" | "google",

          options: {
            redirectTo:
              `${env.BACKEND_ORIGIN.replace(
                /\/$/,
                "",
              )}/api/v1/auth/oauth/callback`,
          },
        });

      if (error) {
        console.error(
          "[OAuth] Supabase OAuth start error:",
          error,
        );

        return res.status(502).json({
          error:
            "Unable to start OAuth sign-in.",
        });
      }

      if (!data.url) {
        console.error(
          "[OAuth] Supabase returned no OAuth URL.",
        );

        return res.status(502).json({
          error:
            "Unable to start OAuth sign-in.",
        });
      }

      console.log(
        `[OAuth] Redirecting to ${provider}...`,
      );

      return res.redirect(data.url);
    } catch (error) {
      console.error(
        "[OAuth] OAuth start exception:",
        error,
      );

      return res.status(500).json({
        error:
          "Unable to start OAuth sign-in.",
      });
    }
  },
);

/*
 * =========================================================
 * REGISTER
 * =========================================================
 */

authRouter.post(
  "/register",
  async (req, res) => {
    const parsed =
      registerSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Please enter valid account details.",
        details:
          parsed.error.flatten(),
      });
    }

    try {
      const user =
        await registerUser(parsed.data);

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
          error:
            "That email or username is already in use.",
        });
      }

      return res.status(500).json({
        error:
          "Unable to create account.",
      });
    }
  },
);

/*
 * =========================================================
 * LOGIN
 * =========================================================
 */

authRouter.post(
  "/login",
  async (req, res) => {
    const parsed =
      loginSchema.safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Enter your email or password.",
      });
    }

    try {
      const user =
        await loginUser(
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
        error:
          "Email or password is incorrect.",
      });
    }
  },
);

/*
 * =========================================================
 * CURRENT USER
 * =========================================================
 */

authRouter.get(
  "/me",
  requireAuth,
  async (req, res) => {
    const user =
      await getUser(
        req.auth!.subjectId,
      );

    if (!user) {
      return res.status(404).json({
        error: "Account not found.",
      });
    }

    return res.json({
      data: user,
    });
  },
);

/*
 * =========================================================
 * ONBOARDING
 * =========================================================
 */

authRouter.post(
  "/onboarding",
  requireAuth,
  async (req, res) => {
    const parsed = z
      .object({
        name: z.string().min(2).max(160),

        username: z
          .string()
          .regex(
            /^[a-zA-Z0-9_.-]{3,40}$/,
          ),

        accountType:
          z.enum(["user", "agent"]),

        interests: z
          .array(
            z
              .string()
              .min(1)
              .max(60),
          )
          .max(12)
          .default([]),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Please complete all required onboarding details.",
      });
    }

    try {
      return res.json({
        data:
          await completeOnboarding(
            req.auth!.subjectId,
            parsed.data,
          ),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message ===
          "USERNAME_EXISTS"
      ) {
        return res.status(409).json({
          error:
            "That username is already in use.",
        });
      }

      return res.status(500).json({
        error:
          "Unable to complete onboarding.",
      });
    }
  },
);

/*
 * =========================================================
 * LOGOUT
 * =========================================================
 */

authRouter.post(
  "/logout",
  requireAuth,
  (_req, res) =>
    res.status(204).send(),
);