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

/*
 * =========================================================
 * APPLICATION JWT
 * =========================================================
 */

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
 * =========================================================
 * COOKIE PARSER
 * =========================================================
 */

function getCookies(req: Request) {
  const header = req.headers.cookie;

  if (!header) {
    return [];
  }

  return header
    .split(";")
    .map((part) => {
      const index = part.indexOf("=");

      if (index === -1) {
        return null;
      }

      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();

      try {
        return {
          name,
          value: decodeURIComponent(value),
        };
      } catch {
        return {
          name,
          value,
        };
      }
    })
    .filter(
      (
        cookie,
      ): cookie is {
        name: string;
        value: string;
      } => cookie !== null,
    );
}

/*
 * =========================================================
 * COOKIE SERIALIZER
 * =========================================================
 */

function serializeCookie(
  name: string,
  value: string,
  options: Record<string, unknown> = {},
) {
  let cookie =
    `${name}=${encodeURIComponent(value)}`;

  const path =
    typeof options.path === "string"
      ? options.path
      : "/";

  cookie += `; Path=${path}`;

  if (typeof options.maxAge === "number") {
    cookie += `; Max-Age=${Math.floor(
      options.maxAge,
    )}`;
  }

  if (options.domain) {
    cookie += `; Domain=${options.domain}`;
  }

  if (options.httpOnly !== false) {
    cookie += "; HttpOnly";
  }

  if (options.secure !== false) {
    cookie += "; Secure";
  }

  if (options.sameSite) {
    const sameSite =
      String(options.sameSite);

    cookie +=
      `; SameSite=${sameSite
        .charAt(0)
        .toUpperCase()}${sameSite.slice(1)}`;
  } else {
    cookie += "; SameSite=Lax";
  }

  if (options.expires instanceof Date) {
    cookie +=
      `; Expires=${options.expires.toUTCString()}`;
  }

  return cookie;
}

/*
 * =========================================================
 * SUPABASE SERVER CLIENT
 * =========================================================
 *
 * IMPORTANT:
 *
 * This is a request-specific Supabase client.
 *
 * The PKCE verifier is stored in cookies during the
 * OAuth-start request and read from those cookies during
 * the OAuth callback.
 *
 * This is the important part that was missing before.
 */

function createSupabaseServerClient(
  req: Request,
  res: Response,
) {
  if (
    !env.SUPABASE_URL ||
    !env.SUPABASE_SERVICE_ROLE_KEY
  ) {
    return null;
  }

  const supabase = createServerClient(
    env.SUPABASE_URL,
    env.SUPABASE_SERVICE_ROLE_KEY,
    {
      cookies: {
        getAll() {
          return getCookies(req);
        },

        setAll(
          cookiesToSet,
          headers,
        ) {
          for (const {
            name,
            value,
            options,
          } of cookiesToSet) {
            res.append(
              "Set-Cookie",
              serializeCookie(
                name,
                value,
                options,
              ),
            );
          }

          /*
           * Supabase SSR can provide cache-control
           * headers when cookies are changed.
           */
          if (headers) {
            for (const [key, value] of Object.entries(
              headers,
            )) {
              res.setHeader(key, value);
            }
          }
        },
      },
    },
  );

  return supabase;
}

export const authRouter = Router();

/*
 * =========================================================
 * OAUTH CALLBACK
 * =========================================================
 *
 * THIS ROUTE MUST COME BEFORE:
 *
 * /oauth/:provider
 *
 * Otherwise "callback" gets interpreted as a provider.
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
        "[OAuth] Authorization code missing.",
      );

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_code_missing`,
      );
    }

    const supabase =
      createSupabaseServerClient(
        req,
        res,
      );

    if (!supabase) {
      console.error(
        "[OAuth] Supabase environment variables are missing.",
      );

      return res.redirect(
        `${env.FRONTEND_ORIGIN}/login?error=oauth_not_configured`,
      );
    }

    try {
      console.log(
        "[OAuth] Exchanging authorization code...",
      );

      /*
       * Supabase reads the PKCE verifier from
       * the cookies supplied by getAll().
       */
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

      const oauthUser = data.user;

      if (!oauthUser?.email) {
        console.error(
          "[OAuth] Supabase returned no email.",
        );

        return res.redirect(
          `${env.FRONTEND_ORIGIN}/login?error=oauth_user_missing`,
        );
      }

      console.log(
        "[OAuth] Supabase authentication successful:",
        oauthUser.email,
      );

      /*
       * Create/find the corresponding Nerddings user.
       */
      const user =
        await findOrCreateOAuthUser({
          email: oauthUser.email,

          name:
            oauthUser.user_metadata
              ?.full_name ??
            oauthUser.user_metadata
              ?.name ??
            null,

          username:
            oauthUser.user_metadata
              ?.user_name ??
            oauthUser.user_metadata
              ?.preferred_username ??
            null,

          avatarUrl:
            oauthUser.user_metadata
              ?.avatar_url ??
            null,
        });

      /*
       * Your application uses its own JWT.
       */
      const token = tokenFor(user);

      console.log(
        "[OAuth] Nerddings user authenticated:",
        user.username,
      );

      /*
       * Send the user back to your frontend.
       */
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
    const provider =
      req.params.provider;

    /*
     * Only Google and GitHub are allowed.
     */
    if (
      provider !== "github" &&
      provider !== "google"
    ) {
      return res.status(404).json({
        error:
          "Unsupported OAuth provider.",
      });
    }

    const supabase =
      createSupabaseServerClient(
        req,
        res,
      );

    if (!supabase) {
      console.error(
        "[OAuth] Supabase is not configured.",
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
            provider as
              | "github"
              | "google",

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
          "[OAuth] Supabase did not return an OAuth URL.",
        );

        return res.status(502).json({
          error:
            "Unable to start OAuth sign-in.",
        });
      }

      console.log(
        `[OAuth] Redirecting to ${provider}...`,
      );

      /*
       * IMPORTANT:
       *
       * Supabase's PKCE verifier cookie is added
       * to this response by setAll().
       *
       * The browser stores that cookie and sends
       * it back when /oauth/callback is reached.
       */
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
      registerSchema.safeParse(
        req.body,
      );

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
        await registerUser(
          parsed.data,
        );

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
      loginSchema.safeParse(
        req.body,
      );

    if (!parsed.success) {
      return res.status(400).json({
        error:
          "Enter your email and password.",
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
          z.enum([
            "user",
            "agent",
          ]),

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
      const user =
        await completeOnboarding(
          req.auth!.subjectId,
          parsed.data,
        );

      return res.json({
        data: user,
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
  (_req, res) => {
    return res.status(204).send();
  },
);