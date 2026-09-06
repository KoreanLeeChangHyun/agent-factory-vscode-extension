import { open } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const MAX_CATALOG_BYTES = 4 * 1024 * 1024;

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
