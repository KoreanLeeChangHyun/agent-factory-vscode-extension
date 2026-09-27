import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ContractEntry { id: string; version: string; title: string; href: string }

/** Read saved contract versions; never infer execution status from a document. */
export async function listContracts(root: string): Promise<ContractEntry[]> {
  const directory = join(root, "docs", "progress");
  const packages = await readdir(directory, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const entries: ContractEntry[] = [];
  for (const pkg of packages) {
    if (!pkg.isDirectory()) continue;
    const folder = join(directory, pkg.name);
    for (const file of await readdir(folder, { withFileTypes: true })) {
      const match = /^contract-v(\d+)\.md$/.exec(file.name);
      if (!file.isFile() || !match) continue;
      const path = join(folder, file.name);
      const content = await readFile(path, "utf8");
      entries.push({ id: pkg.name, version: match[1]!, title: /^#\s+(.+)$/m.exec(content)?.[1] ?? pkg.name, href: pathToFileURL(path).href });
    }
  }
  return entries.sort((a, b) => a.id.localeCompare(b.id) || Number(b.version) - Number(a.version));
}
