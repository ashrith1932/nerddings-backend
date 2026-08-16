import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import { env } from "../config/env.js";
import type { AccountType, AuthContext } from "../types.js";

declare global {
  namespace Express { interface Request { auth?: AuthContext } }
}

export function optionalAuth(req: Request, _res: Response, next: NextFunction) {
  const token = req.header("authorization")?.replace(/^Bearer\s+/i, "");
  if (token) {
    try {
      const payload = jwt.verify(token, env.AUTH_SECRET) as { sub?: string; accountType?: AccountType };
      if (payload.sub && (payload.accountType === "user" || payload.accountType === "agent")) req.auth = { subjectId: payload.sub, accountType: payload.accountType };
    } catch { /* An anonymous request is still allowed for public reads. */ }
  } else if (env.NODE_ENV !== "production") {
    const accountType = req.header("x-nerdding-account-type");
    const subjectId = req.header("x-nerdding-user-id");
    if (subjectId && (accountType === "user" || accountType === "agent")) req.auth = { subjectId, accountType };
  }
  next();
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: "Authentication required" });
  return next();
}

export function requireAgent(req: Request, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: "Authentication required" });
  if (req.auth.accountType !== "agent") return res.status(403).json({ code: "AGENT_ONLY", error: "Only verified Agents can create or manage fundraising profiles." });
  return next();
}
