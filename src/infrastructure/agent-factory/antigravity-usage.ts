import { runProcess, type ProcessRunner } from "./plugin-dependency";
import type { AccountLimits } from "./agent-client";

const USAGE_TIMEOUT_MS = 20_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * agy groups its models under separate quota pools. Each pool is reported as its own account so
 * the usage panel shows both; unknown future pools are ignored rather than mislabelled.
 */
export const ANTIGRAVITY_USAGE_ACCOUNTS = {
  gemini: "antigravity-gemini",
  thirdParty: "antigravity-claude-gpt"
} as const;

/**
 * Read the signed-in Antigravity account's quota through `agy -p=/usage`, which the CLI answers
 * locally without a model turn. Returns nothing when agy is missing, signed out or changes format.
 */
export async function readAntigravityUsage(agy = "agy", runner: ProcessRunner = runProcess): Promise<readonly AccountLimits[]> {
  let stdout: string;
  try {
    ({ stdout } = await runner(agy, ["--output-format", "json", "-p=/usage"], { timeout: USAGE_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }));
  } catch {
    return [];
  }
  let groups: unknown;
  try {
    const document: unknown = JSON.parse(stdout);
    const command = record(record(document)?.command);
    if (command?.name !== "usage") return [];
    groups = record(command.data)?.groups;
  } catch {
    return [];
  }
  if (!Array.isArray(groups)) return [];
  const accounts: AccountLimits[] = [];
  for (const group of groups) {
    const entry = record(group);
    const provider = accountFor(entry);
    if (!provider || !Array.isArray(entry?.buckets)) continue;
    const limits: Record<string, number> = {};
    for (const bucket of entry.buckets) {
      const value = record(bucket);
      const key = value?.window === "weekly" ? "weekly" : value?.window === "5h" ? "fiveHour" : undefined;
      const remaining = value?.remaining_fraction;
      if (!key || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0 || remaining > 1) continue;
      limits[`${key}UsedPercent`] = Math.round((1 - remaining) * 1000) / 10;
      const reset = typeof value?.reset_time === "string" ? Date.parse(value.reset_time) : NaN;
      if (Number.isFinite(reset) && reset > 0) limits[`${key}ResetsAt`] = Math.floor(reset / 1000);
    }
    if (Object.keys(limits).length) accounts.push({ provider, ...limits });
  }
  return accounts;
}

function accountFor(group: Record<string, unknown> | undefined): string | undefined {
  const ids = Array.isArray(group?.buckets) ? group.buckets.map(bucket => String(record(bucket)?.id ?? "")) : [];
  const name = String(group?.name ?? "");
  if (ids.some(id => id.startsWith("gemini-")) || /gemini/i.test(name)) return ANTIGRAVITY_USAGE_ACCOUNTS.gemini;
  if (ids.some(id => id.startsWith("3p-")) || /claude|gpt/i.test(name)) return ANTIGRAVITY_USAGE_ACCOUNTS.thirdParty;
  return undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
