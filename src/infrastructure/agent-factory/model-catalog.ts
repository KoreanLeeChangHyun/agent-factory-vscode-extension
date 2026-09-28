import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { claudeExecutable, runtimeEnvironment } from "./process-environment";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

// Pinned Claude model ids first, then the tracking aliases (always the latest of each family).
// The runtime passes full ids to `claude --model` unchanged; Claude checks availability at execution time.
export const CLAUDE_MODELS = [
  "claude-opus-5-5", "claude-sonnet-5", "claude-fable-5-1", "claude-haiku-4-5-20251001",
  "claude-opus", "claude-sonnet", "claude-haiku"
] as const;

const CLAUDE_PROBE_TTL_MS = 60_000;
const claudeProbes = new Map<string, { readonly checkedAt: number; readonly available: Promise<boolean> }>();

export async function readProviderModels(
  codexHome?: string, claude = claudeExecutable(), agy = "agy"
): Promise<readonly string[] | undefined> {
  const [codex, claudeAvailable, antigravity] = await Promise.all([readCodexModels(codexHome), isClaudeAvailable(claude), readAntigravityModels(agy)]);
  const models = [...(codex ?? []), ...(claudeAvailable ? CLAUDE_MODELS : []), ...antigravity];
  return models.length || codex ? [...new Set(models)] : undefined;
}

const antigravityProbes = new Map<string, { readonly checkedAt: number; readonly models: Promise<readonly string[]> }>();

/** `agy models` lists the signed-in subscription's models; probe each executable at most once a minute. */
export function readAntigravityModels(agy = "agy"): Promise<readonly string[]> {
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
