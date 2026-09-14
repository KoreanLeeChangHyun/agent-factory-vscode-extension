export const STATUS_ITEM_IDS = [
  "agent",
  "status",
  "agents",
  "project",
  "branch",
  "context",
  "elapsed",
  "queue",
  "runtime",
  "role",
  "model",
  "reasoning",
  "fast",
  "goal",
  "task",
  "execution",
  "contextUsed",
  "contextWindow",
  "weekly",
  "agentsTotal",
  "goalTokens",
  "goalTime",
  "goalBudget"
] as const;

export type StatusItemId = (typeof STATUS_ITEM_IDS)[number];
