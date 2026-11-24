/** What a change touches. Reviewers list the areas they are good at. Order: most sensitive first. */
export const AREAS = [
  "security",
  "payments",
  "data",
  "infra",
  "code",
  "frontend",
  "design",
  "tests",
  "docs",
] as const;
export type Area = (typeof AREAS)[number];

/** From least to most. */
export const RISKS = ["low", "medium", "high"] as const;
export type Risk = (typeof RISKS)[number];

export type Kind = "diff" | "question";
