/** UI-only companion state. Never changes an Agent's execution state. */
export const COMPANION_ACTIONS = ["call", "pet", "praise", "feed", "play", "sleep"] as const;
export type CompanionAction = typeof COMPANION_ACTIONS[number];
export interface CompanionState {
  emotion: "calm" | "happy" | "shy" | "love" | "surprised" | "playful" | "sleepy";
  action: CompanionAction;
  reactionUntil: number;
  lastInteractionAt: number;
  fullness: number;
  happiness: number;
  energy: number;
  careCount: number;
  updatedAt: number;
}
export function restoreCompanion(raw: unknown, now = Date.now()): CompanionState {
  const value = (raw && typeof raw === "object" ? raw : {}) as Partial<CompanionState>;
  const stat = (key: "fullness" | "happiness" | "energy") =>
    Number.isFinite(value[key]) ? Math.max(0, Math.min(100, value[key]!)) : 80;
  const timestamp = (value: unknown, fallback: number) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= now ? value : fallback;
  return {
    emotion: ["calm", "happy", "shy", "love", "surprised", "playful", "sleepy"].includes(value.emotion!) ? value.emotion! : "calm",
    action: COMPANION_ACTIONS.includes(value.action!) ? value.action! : "call",
    reactionUntil: Number.isFinite(value.reactionUntil) ? Math.min(now + 6000, value.reactionUntil!) : 0,
    lastInteractionAt: timestamp(value.lastInteractionAt, now),
    fullness: stat("fullness"), happiness: stat("happiness"), energy: stat("energy"),
    careCount: Number.isSafeInteger(value.careCount) && value.careCount! >= 0 ? value.careCount! : 0,
    updatedAt: timestamp(value.updatedAt, now)
  };
}
export function interactCompanion(current: CompanionState, action: CompanionAction, now = Date.now()): CompanionState {
  const state = restoreCompanion(current, now);
  const wasSleepy = now - state.lastInteractionAt >= 60000 || state.action === "sleep";
  const emotion: CompanionState["emotion"] = action === "call" ? (wasSleepy ? "surprised" : "happy")
    : action === "pet" ? "love" : action === "praise" ? "shy"
    : action === "play" ? "playful" : action === "sleep" ? "sleepy" : "happy";
  return { ...state, action, emotion, updatedAt: now, lastInteractionAt: action === "sleep" ? now - 60000 : now,
    reactionUntil: now + 5000,
    fullness: Math.min(100, state.fullness + (action === "feed" ? 25 : 0)),
    happiness: Math.min(100, state.happiness + (action === "pet" || action === "praise" || action === "play" ? 10 : 0)),
    energy: Math.max(0, Math.min(100, state.energy + (action === "sleep" ? 10 : action === "play" ? -5 : 0))),
    careCount: state.careCount + (action === "call" ? 0 : 1) };
}
