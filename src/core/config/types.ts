export const STATUS_ITEM_IDS = [
  "agent",
  "status",
  "agents",
  "project",
  "branch",
  "context",
  "elapsed",
  "queue",
  "runtime"
] as const;

export type StatusItemId = (typeof STATUS_ITEM_IDS)[number];
