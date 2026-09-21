import { lstat, mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { decodeBrowserImage } from "../../common/image-input";
import { writeNewImageAttachment } from "./image-attachment-store";

const extensions: Record<string, string> = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" };

/** Only new files in the selected project's docs/output; never follow output symlinks. */
export async function saveConvertedImage(root: string, name: string, mediaType: string, data: string, size: number): Promise<string> {
  const extension = extensions[mediaType];
  if (!extension) throw new Error("Unsupported output image format");
  const content = decodeBrowserImage(data, size, mediaType);
  let directory = await realpath(root);
  for (const part of ["docs", "output"]) {
    directory = join(directory, part);
    try { await mkdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Output directory must not be a symbolic link");
  }
  const stem = name.replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/[. ]+$/g, "").slice(0, 100) || "image";
  for (let index = 0; ; index++) {
    const path = join(directory, `${stem}${index ? ` (${index})` : ""}${extension}`);
    try { await writeNewImageAttachment(path, content); return path; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}
