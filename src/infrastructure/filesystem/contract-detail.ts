import { readFile, realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { listContracts } from "./contracts";

export function parseOperations(text: string): Record<string, string>[] {
  const rows: string[][] = []; let row: string[] = [], value = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { value += '"'; i++; } else quoted = !quoted; }
    else if (c === ',' && !quoted) { row.push(value); value = ""; }
    else if (c === '\n' && !quoted) { row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = ""; }
    else value += c;
  }
  if (quoted) throw new Error("Invalid file operations CSV");
  if (value || row.length) { row.push(value); rows.push(row); }
  const headers = rows.shift() ?? [];
  return rows.filter(r => r.some(Boolean)).map(r => Object.fromEntries(headers.map((h, i) => [h.trim(), r[i] ?? ""])));
}

export async function readContractDetail(root: string, id: string) {
  const entries = (await listContracts(root)).filter(e => e.id === id);
  if (!entries.length) throw new Error("Contract not found");
  const base = await realpath(join(root, "docs/progress"));
  async function read(path: string, optional = false): Promise<string> {
    try {
      const actual = await realpath(path);
      if (!actual.startsWith(base + sep)) throw new Error("Contract path outside progress directory");
      return await readFile(actual, "utf8");
    } catch (error) { if (optional && (error as NodeJS.ErrnoException).code === "ENOENT") return ""; throw error; }
  }
  const versions = await Promise.all(entries.map(async e => {
    const path = fileURLToPath(e.href);
    const operations = await read(join(root, "docs/progress", id, `file-operations-v${e.version}.csv`), true);
    return { ...e, content: await read(path), modifiedAt: (await stat(path)).mtime.toISOString(), operations: parseOperations(operations) };
  }));
  return { id, versions, progress: await read(join(root, "docs/progress", id, "progress.md"), true), observedAt: new Date().toISOString() };
}

