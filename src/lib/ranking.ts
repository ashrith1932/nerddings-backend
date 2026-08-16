import type { ExploreStory, FeedPost, RankingSignals } from "../types.js";

const weights: Record<keyof RankingSignals, number> = {
  relevance: 0.22,
  freshness: 0.14,
  proofOfWork: 0.2,
  meaningfulEngagement: 0.16,
  trust: 0.1,
  projectActivity: 0.08,
  relationship: 0.07,
  spamPenalty: 0.17,
};

export function scoreSignals(signals: RankingSignals) {
  const positive = (Object.keys(weights) as Array<keyof RankingSignals>).reduce((total, key) => {
    if (key === "spamPenalty") return total;
    return total + signals[key] * weights[key];
  }, 0);
  return Math.max(0, Math.round((positive - signals.spamPenalty * weights.spamPenalty) * 100) / 100);
}

export function scoreFeedPost(post: FeedPost) {
  return scoreSignals(post.signals);
}

export function rankFeed(posts: FeedPost[]) {
  return posts.map((post) => ({ ...post, score: scoreFeedPost(post) })).sort((a, b) => b.score - a.score);
}

export function scoreExploreStory(story: ExploreStory) {
  return scoreFeedPost(story) + story.topicVelocity * 0.12 + story.saveRate * 0.08;
}

export function rankExplore(stories: ExploreStory[]) {
  return stories.map((story) => ({ ...story, score: Math.round(scoreExploreStory(story) * 100) / 100 })).sort((a, b) => b.score - a.score);
}

export function scoreTopChart(input: { proofOfWork: number; meaningfulEngagement: number; consistency: number; collaboration: number; projectVisits: number; followers: number; spamPenalty: number }) {
  return Math.round((input.proofOfWork * 0.27 + input.meaningfulEngagement * 0.2 + input.consistency * 0.18 + input.collaboration * 0.16 + input.projectVisits * 0.12 + input.followers * 0.04 - input.spamPenalty * 0.2) * 100) / 100;
}
