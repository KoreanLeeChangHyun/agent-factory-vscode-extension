import { open, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { antigravityExecutable, claudeExecutable, runtimeEnvironment } from "./process-environment";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

const CLAUDE_PROBE_TTL_MS = 60_000;
const claudeProbes = new Map<string, { readonly checkedAt: number; readonly available: Promise<boolean> }>();

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
}

// Claude Code owns and refreshes this account-specific catalog. Read it again for each picker request.
export async function readClaudeModels(
  claudeConfigDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
): Promise<readonly string[]> {
  const directory = join(claudeConfigDir, "cache", "model-catalog");
  let names: readonly string[];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
      .map(entry => entry.name);
  } catch {
    return [];
  }
  const catalogs = (await Promise.all(names.map(name => readClaudeCatalog(join(directory, name)))))
    .filter((catalog): catalog is ClaudeCatalog => catalog !== undefined)
    .sort((left, right) => right.fetchedAt - left.fetchedAt);
  return catalogs[0]?.models ?? [];
}

async function readClaudeCatalog(path: string): Promise<ClaudeCatalog | undefined> {
  try {
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_CATALOG_BYTES) return undefined;
      const bytes = Buffer.alloc(MAX_CATALOG_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CATALOG_BYTES) return undefined;
      const document: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
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
      return { fetchedAt: document.fetchedAt, models };
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
      if (!info.isFile() || info.size > MAX_CATALOG_BYTES) return undefined;
      const bytes = Buffer.alloc(MAX_CATALOG_BYTES + 1);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_CATALOG_BYTES) return undefined;
      const catalog: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
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
