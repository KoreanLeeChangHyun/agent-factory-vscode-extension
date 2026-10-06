import { open, readFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { antigravityExecutable, claudeExecutable, runtimeEnvironment } from "./process-environment";


const CLAUDE_PROBE_TTL_MS = 60_000;
const claudeProbes = new Map<string, { readonly checkedAt: number; readonly available: Promise<boolean> }>();

/** Selection evidence only: a provider catalog is not authority or a quality benchmark. */
export async function modelSelectionCatalog(codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")) {
  const ids = await readProviderModels(codexHome);
  const claude = await latestClaudeCatalog(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"));
  const source = join(codexHome, "models_cache.json");
  let models: Record<string, unknown>[] = [];
  let revision: string | undefined;
  let providerVersion: unknown = "unknown";
  let fetchedAt: unknown = "unknown";
  try {
    const bytes = await readFile(source);
    const cache = JSON.parse(bytes.toString("utf8"));
    models = Array.isArray(cache.models) ? cache.models : [];
    revision = createHash("sha256").update(bytes).digest("hex");
    providerVersion = cache.client_version ?? "unknown";
    fetchedAt = cache.fetched_at ?? "unknown";
  } catch { /* The picker remains usable with other providers and historical caches. */ }
  return {
    schemaVersion: 1, checkedAt: new Date().toISOString(),
    availability: ids === undefined ? "unknown" : "provider-catalog-observed",
    candidates: (ids ?? []).map(id => {
      const model = models.find(item => item?.slug === id);
      const provider = id.startsWith("claude-") ? "claude" : id.startsWith("gemini-") || id.startsWith("antigravity/") ? "antigravity" : "codex";
      return {
        id, provider, evidenceKind: "provider-observation",
        suitableTasks: model?.description ?? claude?.entries.find(item => item.id === id)?.description ?? "unknown",
        quality: "unknown", cost: "unknown", latency: "unknown",
        constraints: {
          reasoningEfforts: Array.isArray(model?.supported_reasoning_levels)
            ? model.supported_reasoning_levels.map((level: { effort?: string }) => level?.effort ?? "unknown") : "unknown",
          modalities: model?.input_modalities ?? "unknown",
          contextWindow: model?.context_window ?? "unknown",
          toolMode: model?.tool_mode ?? "unknown",
          serviceTiers: model?.service_tiers ?? "unknown",
          accessPrograms: model?.available_access_programs ?? "unknown",
          apiAvailability: model?.supported_in_api ?? "unknown",
          runtimeSupport: "Provider observations can exceed the installed CLI/runtime flags; check the exact requested setting",
          fast: "check runtime capabilities for the exact model",
          authority: "preserve captured route and role permissions"
        },
        detail: model ? { source, revision, providerVersion, fetchedAt, selector: { slug: id },
          officialReference: "https://learn.chatgpt.com/docs/models" }
          : provider === "claude" && claude ? { source: claude.source, revision: claude.revision,
            providerVersion: "unknown", fetchedAt: claude.fetchedAt, selector: { id } }
          : provider === "codex" ? { source, revision: revision ?? "unknown", providerVersion, selector: { slug: id } }
          : { source: `${antigravityExecutable()} models`, revision: "unknown", providerVersion: "unknown", selector: { id } }
      };
    })
  };
}

export interface ProviderSelection {
  readonly codex?: boolean;
  readonly claude?: boolean;
  readonly antigravity?: boolean;
}

/** Only providers whose CLI was detected contribute models; an unset flag counts as detected. */
export async function readProviderModels(
  codexHome?: string, claude = claudeExecutable(), agy = antigravityExecutable(),
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
  providers: ProviderSelection = {}
): Promise<readonly string[] | undefined> {
  const claudeAvailable = providers.claude === false ? Promise.resolve(false) : isClaudeAvailable(claude);
  const [codex, claudeModels, antigravity] = await Promise.all([
    providers.codex === false ? [] : readCodexModels(codexHome),
    claudeAvailable.then(available => available ? readClaudeModels(claudeConfigDir) : []),
    providers.antigravity === false ? [] : readAntigravityModels(agy)
  ]);
  const models = [...(codex ?? []), ...claudeModels, ...antigravity];
  return models.length || codex ? [...new Set(models)] : undefined;
}

interface ClaudeCatalog {
  readonly fetchedAt: number;
  readonly models: readonly string[];
  readonly source: string;
  readonly revision: string;
  readonly entries: readonly { id: string; description?: string }[];
}

// Claude Code owns and refreshes this account-specific catalog. Read it again for each picker request.
export async function readClaudeModels(
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
): Promise<readonly string[]> {
  return (await latestClaudeCatalog(claudeConfigDir))?.models ?? [];
}

async function latestClaudeCatalog(claudeConfigDir: string): Promise<ClaudeCatalog | undefined> {
  const directory = join(claudeConfigDir, "cache", "model-catalog");
  let names: readonly string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => entry.name);
  } catch {
    return undefined;
  }
  const catalogs = (await Promise.all(names.map(name => readClaudeCatalog(join(directory, name)))))
    .filter((catalog): catalog is ClaudeCatalog => catalog !== undefined)
    .sort((left, right) => right.fetchedAt - left.fetchedAt);
  return catalogs[0];
}

async function readClaudeCatalog(path: string): Promise<ClaudeCatalog | undefined> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) return undefined;
      const bytes = await file.readFile();
      const document: unknown = JSON.parse(bytes.toString("utf8"));
      if (!document || typeof document !== "object" || !("catalog" in document)
          || !("fetchedAt" in document) || typeof document.fetchedAt !== "number"
          || !Number.isFinite(document.fetchedAt)) return undefined;
      const catalog = document.catalog;
      if (!catalog || typeof catalog !== "object" || !("surface" in catalog) || catalog.surface !== "cc"
          || !("config" in catalog) || !catalog.config || typeof catalog.config !== "object"
          || !("models" in catalog.config) || !Array.isArray(catalog.config.models)) return undefined;
      const models = [...new Set<string>(catalog.config.models.flatMap((model: unknown) => {
        if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string"
            || !/^claude-[A-Za-z0-9][A-Za-z0-9._-]{0,92}$/.test(model.id)) return [];
        return [model.id];
      }))];
      const entries = catalog.config.models.flatMap((model: unknown) => {
        if (!model || typeof model !== "object" || !("id" in model) || typeof model.id !== "string" || !models.includes(model.id)) return [];
        return [{ id: model.id, ...("description" in model && typeof model.description === "string" ? { description: model.description } : {}) }];
      });
      return { fetchedAt: document.fetchedAt, models, entries, source: path,
        revision: createHash("sha256").update(bytes).digest("hex") };
    } finally {
      await file.close();
    }
  } catch {
    // Missing, stale, or partially rewritten entries do not hide another valid Claude Code catalog.
    return undefined;
  }
}

const antigravityProbes = new Map<string, { readonly checkedAt: number; readonly models: Promise<readonly string[]> }>();

/** `agy models` lists the signed-in subscription's models; probe each executable at most once a minute. */
export function readAntigravityModels(agy = antigravityExecutable()): Promise<readonly string[]> {
  const cached = antigravityProbes.get(agy);
  if (cached && Date.now() - cached.checkedAt < CLAUDE_PROBE_TTL_MS) return cached.models;
  const models = promisify(execFile)(agy, ["models"], {
    cwd: homedir(), env: runtimeEnvironment(), timeout: 15000, maxBuffer: 1024 * 1024, encoding: "utf8"
  }).then(({ stdout }) => antigravityModels(stdout.split("\n").map(line => line.split("\t")[0]?.trim() ?? "")),
    // Not installed or not signed in: the other providers' catalogs stay usable.
    () => []);
  antigravityProbes.set(agy, { checkedAt: Date.now(), models });
  return models;
}

/**
 * Gemini ids ending in an effort level collapse to their base id, which takes the reasoning
 * slider as `--effort`. Other families are named `antigravity/<id>` so the runtime selects
 * Antigravity instead of the vendor's own CLI.
 */
export function antigravityModels(ids: readonly string[]): readonly string[] {
  const result = new Set<string>();
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(id)) continue;
    const gemini = /^(gemini-.+)-(?:low|medium|high)$/.exec(id);
    result.add(gemini ? gemini[1]! : id.startsWith("gemini-") ? id : `antigravity/${id}`);
  }
  return [...result];
}

/** The picker asks often; probe each executable at most once a minute. */
function isClaudeAvailable(claude: string): Promise<boolean> {
  const cached = claudeProbes.get(claude);
  if (cached && Date.now() - cached.checkedAt < CLAUDE_PROBE_TTL_MS) return cached.available;
  const available = promisify(execFile)(claude, ["--version"], {
    cwd: homedir(), env: runtimeEnvironment(), timeout: 5000, maxBuffer: 65536, encoding: "utf8"
  }).then(({ stdout }) => stdout.includes("Claude Code"),
    // An optional provider must not hide the existing model catalog.
    () => false);
  claudeProbes.set(claude, { checkedAt: Date.now(), available });
  return available;
}

// Codex owns refreshing this cache; read it again for each model picker request.
export async function readCodexModels(
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex")
): Promise<readonly string[] | undefined> {
  try {
    const file = await open(join(codexHome, "models_cache.json"), "r");
    try {
      const info = await file.stat();
      if (!info.isFile()) return undefined;
      const bytes = await file.readFile();
      const catalog: unknown = JSON.parse(bytes.toString("utf8"));
      if (!catalog || typeof catalog !== "object" || !("models" in catalog) || !Array.isArray(catalog.models)) {
        return undefined;
      }
      return [...new Set<string>(catalog.models.flatMap((model: unknown) => {
        if (!model || typeof model !== "object" || !("visibility" in model) || model.visibility !== "list" ||
            !("slug" in model) || typeof model.slug !== "string" ||
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(model.slug)) return [];
        return [model.slug];
      }))];
    } finally {
      await file.close();
    }
  } catch {
    // A missing or partially rewritten cache must not discard the current selection.
    return undefined;
  }
}
