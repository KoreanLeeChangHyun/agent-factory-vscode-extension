export const STATUS_ITEM_IDS = [
  "agent",
  "status",
  "agents",
  "model",
  "reasoning",
  "fast",
  "goal",
  "project",
  "branch",
  "context",
  "elapsed",
  "queue",
  "runtime"
] as const;

export type StatusItemId = (typeof STATUS_ITEM_IDS)[number];
