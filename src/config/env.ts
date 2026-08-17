import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(4000),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().optional(),
  AUTH_SECRET: z.string().min(16).default("local-development-secret-change-me"),
  FRONTEND_ORIGIN: z.string().default("http://localhost:3000"),
  BACKEND_ORIGIN: z.string().default("http://localhost:4000"),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20).optional(),
  STORAGE_BUCKET: z.string().default("nerdding-media"),
  VERIFICATION_ADMIN_EMAILS: z.string().default(""),
});

export const env = envSchema.parse(process.env);

export const verificationAdminEmails = new Set(
  env.VERIFICATION_ADMIN_EMAILS
    .split(",")
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);
