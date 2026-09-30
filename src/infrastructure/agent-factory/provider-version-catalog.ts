import type { ProviderId, ProviderStatus } from "./provider-detection";

export interface ProviderVersionCatalog {
  readonly factory: readonly string[];
  readonly cli: Readonly<Partial<Record<"codex" | "claude", readonly string[]>>>;
  readonly errors: Readonly<Partial<Record<"factory" | "codex" | "claude", boolean>>>;
}

const VERSION = /^\d+\.\d+\.\d+$/;
const REPOSITORIES: Readonly<Record<ProviderId, string>> = {
  codex: "KoreanLeeChangHyun/agent-factory-codex-plugin",
  claude: "KoreanLeeChangHyun/agent-factory-claude-plugin",
  antigravity: "KoreanLeeChangHyun/agent-factory-antigravity-plugin"
};

export function sortedVersions(values: readonly string[]): string[] {
  return [...new Set(values.filter(value => VERSION.test(value)))].sort((left, right) => {
    const a = left.split(".").map(Number), b = right.split(".").map(Number);
    return (b[0] ?? 0) - (a[0] ?? 0) || (b[1] ?? 0) - (a[1] ?? 0) || (b[2] ?? 0) - (a[2] ?? 0);
  });
}

async function githubTags(repository: string): Promise<string[]> {
  const tags: string[] = [];
  for (let page = 1; ; page++) {
    const response = await fetch(`https://api.github.com/repos/${repository}/tags?per_page=100&page=${page}`, {
      headers: { Accept: "application/vnd.github+json" }, signal: AbortSignal.timeout(15_000)
    });
    if (!response.ok) throw new Error(`GitHub tags unavailable (${response.status}).`);
    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) throw new Error("Invalid GitHub tag response.");
    tags.push(...payload.filter(item => item && typeof item.name === "string")
      .map(item => item.name.replace(/^v/, "")));
    if (payload.length < 100) break;
  }
  return sortedVersions(tags);
}

async function npmVersions(name: "@openai/codex" | "@anthropic-ai/claude-code"): Promise<string[]> {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}`, {
    headers: { Accept: "application/vnd.npm.install-v1+json" }, signal: AbortSignal.timeout(20_000)
  });
  if (!response.ok) throw new Error(`npm versions unavailable (${response.status}).`);
  const payload: unknown = await response.json();
  if (!payload || typeof payload !== "object" || !Object.hasOwn(payload, "versions")
      || typeof (payload as { versions?: unknown }).versions !== "object"
      || (payload as { versions?: unknown }).versions === null) throw new Error("Invalid npm version response.");
  return sortedVersions(Object.keys((payload as { versions: object }).versions));
}

/** Available stable versions from each provider's official release source. */
export async function readProviderVersionCatalog(
  statuses: readonly ProviderStatus[], installedPlugins: Partial<Readonly<Record<ProviderId, string>>>
): Promise<ProviderVersionCatalog> {
  const detected = statuses.filter(status => status.detected).map(status => status.id);
  const entries = await Promise.allSettled([
    ...detected.map(id => githubTags(REPOSITORIES[id])),
    ...(detected.includes("codex") ? [npmVersions("@openai/codex")] : []),
    ...(detected.includes("claude") ? [npmVersions("@anthropic-ai/claude-code")] : [])
  ]);
  const errors: Partial<Record<"factory" | "codex" | "claude", boolean>> = {};
  const tagLists = entries.slice(0, detected.length);
  if (tagLists.some(result => result.status === "rejected")) errors.factory = true;
  let factory = !errors.factory && tagLists.length
    ? (tagLists[0] as PromiseFulfilledResult<string[]>).value.filter(version =>
      tagLists.every(result => result.status === "fulfilled" && result.value.includes(version))) : [];
  if (detected.includes("antigravity")) {
    const installed = installedPlugins.antigravity?.split("+", 1)[0];
    factory = installed ? factory.filter(version => version === installed) : [];
    if (!factory.length) errors.factory = true;
  }
  const cli: Partial<Record<"codex" | "claude", readonly string[]>> = {};
  let index = detected.length;
  for (const id of ["codex", "claude"] as const) {
    if (!detected.includes(id)) continue;
    const result = entries[index++];
    if (result?.status === "fulfilled") cli[id] = result.value;
    else errors[id] = true;
  }
  return { factory, cli, errors };
}
