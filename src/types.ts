export type AccountType = "user" | "agent";

export type AuthContext = {
  subjectId: string;
  accountType: AccountType;
};

export type RankingSignals = {
  relevance: number;
  freshness: number;
  proofOfWork: number;
  meaningfulEngagement: number;
  trust: number;
  projectActivity: number;
  relationship: number;
  spamPenalty: number;
};

export type FeedPost = {
  id: string;
  authorId: string;
  text: string;
  topic: string;
  createdAt: string;
  signals: RankingSignals;
  projectSlug?: string;
  quotePostId?: string;
};

export type ExploreStory = FeedPost & {
  kind: "Hot discussion" | "Build story" | "Launch";
  topicVelocity: number;
  saveRate: number;
};

export type Fundraising = {
  id: string;
  agentId: string;
  startupName: string;
  stage: "Pre-seed" | "Seed" | "Series A" | "Series B";
  industry: string;
  targetAmount: number;
  raisedAmount: number;
  currency: "INR" | "USD";
  investorCount: number;
  visibility: "public" | "investors-only";
  createdAt: string;
};
