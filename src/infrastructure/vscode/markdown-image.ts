import { open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hasImageSignature } from "../../common/image-input";

/** Read only bounded raster images within a canonical workspace root. */
export async function readMarkdownImage(href: string, roots: readonly string[]): Promise<string | undefined> {
  try {
    if (!roots.length || !/^(?:file:\/\/|\/|\.\.?\/)/i.test(href)) return undefined;
    const path = await realpath(href.startsWith("file://") ? fileURLToPath(href) : resolve(roots[0]!, href));
    const allowed = await Promise.all(roots.map(async root => {
      const child = relative(await realpath(root), path);
      return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
    }));
    if (!allowed.some(Boolean)) return undefined;
    const file = await open(path, "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size < 1) return undefined;
      const data = Buffer.alloc(info.size);
      let offset = 0;
      while (offset < data.length) {
        const { bytesRead } = await file.read(data, offset, data.length - offset, offset);
        if (!bytesRead) return undefined;
        offset += bytesRead;
      }
      const type = ["image/png", "image/jpeg", "image/gif", "image/webp"].find(type => hasImageSignature(data, type));
      return type ? `data:${type};base64,${data.toString("base64")}` : undefined;
    } finally { await file.close(); }
  } catch { return undefined; }
}
