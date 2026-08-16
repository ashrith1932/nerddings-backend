import type { ExploreStory, FeedPost, Fundraising } from "../types.js";

export const feedPosts: FeedPost[] = [
  { id: "p-loomly", authorId: "ashrith", text: "The first working version of Loomly is live.", topic: "product", createdAt: "2026-08-16T08:00:00.000Z", projectSlug: "loomly", signals: { relevance: 0.96, freshness: 0.92, proofOfWork: 0.94, meaningfulEngagement: 0.74, trust: 0.86, projectActivity: 0.88, relationship: 0.9, spamPenalty: 0.01 } },
  { id: "p-threadline", authorId: "rahul", text: "Threadline just crossed 400 contributors.", topic: "open-source", createdAt: "2026-08-16T06:00:00.000Z", projectSlug: "threadline", signals: { relevance: 0.88, freshness: 0.82, proofOfWork: 0.98, meaningfulEngagement: 0.82, trust: 0.9, projectActivity: 0.93, relationship: 0.6, spamPenalty: 0.01 } },
  { id: "p-fieldnote", authorId: "maya", text: "Fieldnote is now helping 120 farms make irrigation decisions.", topic: "climate", createdAt: "2026-08-16T04:00:00.000Z", projectSlug: "fieldnote", signals: { relevance: 0.82, freshness: 0.75, proofOfWork: 0.93, meaningfulEngagement: 0.79, trust: 0.88, projectActivity: 0.91, relationship: 0.5, spamPenalty: 0.02 } },
];

export const exploreStories: ExploreStory[] = [
  { ...feedPosts[1], kind: "Launch", topicVelocity: 0.9, saveRate: 0.8 },
  { ...feedPosts[2], kind: "Build story", topicVelocity: 0.88, saveRate: 0.84 },
  { ...feedPosts[0], kind: "Hot discussion", topicVelocity: 0.82, saveRate: 0.77 },
];

export const fundraisings: Fundraising[] = [
  { id: "fund-kora", agentId: "agent-kora", startupName: "Kora", stage: "Pre-seed", industry: "Fintech", targetAmount: 4500000, raisedAmount: 2875000, currency: "INR", investorCount: 18, visibility: "public", createdAt: "2026-08-01T00:00:00.000Z" },
  { id: "fund-fieldnote", agentId: "agent-fieldnote", startupName: "Fieldnote", stage: "Seed", industry: "Climate", targetAmount: 12000000, raisedAmount: 7200000, currency: "INR", investorCount: 9, visibility: "public", createdAt: "2026-07-25T00:00:00.000Z" },
];

export function addFundraising(fundraising: Fundraising) {
  fundraisings.unshift(fundraising);
  return fundraising;
}
