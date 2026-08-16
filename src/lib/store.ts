import type { ExploreStory, FeedPost, Fundraising } from "../types.js";

export const feedPosts: FeedPost[] = [];

export const exploreStories: ExploreStory[] = [];

export const fundraisings: Fundraising[] = [];

export function addFundraising(fundraising: Fundraising) {
  fundraisings.unshift(fundraising);
  return fundraising;
}
