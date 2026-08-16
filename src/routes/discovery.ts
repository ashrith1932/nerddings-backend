import { Router } from "express";
import { exploreStories } from "../lib/store.js";
import { rankExplore, scoreTopChart } from "../lib/ranking.js";

export const discoveryRouter = Router();

discoveryRouter.get("/explore", (_req, res) => {
  res.json({ data: rankExplore(exploreStories), algorithm: "meaningful-velocity-v1" });
});

discoveryRouter.get("/charts", (_req, res) => {
  const builders = [
    { id: "rahul", name: "Rahul Sharma", score: scoreTopChart({ proofOfWork: 0.98, meaningfulEngagement: 0.82, consistency: 0.88, collaboration: 0.74, projectVisits: 0.92, followers: 0.42, spamPenalty: 0.01 }) },
    { id: "maya", name: "Maya Patel", score: scoreTopChart({ proofOfWork: 0.93, meaningfulEngagement: 0.79, consistency: 0.9, collaboration: 0.72, projectVisits: 0.82, followers: 0.48, spamPenalty: 0.02 }) },
    { id: "nina", name: "Nina Okafor", score: scoreTopChart({ proofOfWork: 0.9, meaningfulEngagement: 0.71, consistency: 0.84, collaboration: 0.76, projectVisits: 0.76, followers: 0.5, spamPenalty: 0.02 }) },
  ].sort((a, b) => b.score - a.score);
  res.json({ data: { risingBuilders: builders, topProjects: [], trendingStartups: [], activeCommunities: [] }, algorithm: "proof-and-collaboration-v1" });
});
