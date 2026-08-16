import { Router } from "express";
import { exploreStories } from "../lib/store.js";
import { rankExplore, scoreTopChart } from "../lib/ranking.js";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { desc } from "drizzle-orm";

export const discoveryRouter = Router();

discoveryRouter.get("/explore", (_req, res) => {
  res.json({ data: rankExplore(exploreStories), algorithm: "meaningful-velocity-v1" });
});

discoveryRouter.get("/charts", (_req, res) => {
  if (!db) return res.json({ data: { risingBuilders: [], topProjects: [], trendingStartups: [], activeCommunities: [] }, algorithm: "proof-and-collaboration-v1" });
  void db.select({ id: users.id, name: users.name, username: users.username, trustScore: users.trustScore, accountType: users.accountType }).from(users).orderBy(desc(users.trustScore)).limit(20).then((rows) => res.json({ data: { risingBuilders: rows.map((user) => ({ ...user, score: scoreTopChart({ proofOfWork: user.trustScore / 100, meaningfulEngagement: user.trustScore / 100, consistency: user.trustScore / 100, collaboration: user.trustScore / 100, projectVisits: user.trustScore / 100, followers: 0, spamPenalty: 0 }) })), topProjects: [], trendingStartups: [], activeCommunities: [] }, algorithm: "proof-and-collaboration-v1" })).catch(() => res.status(500).json({ error: "Charts are temporarily unavailable." }));
});
