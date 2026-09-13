import { constants as fsConstants } from "node:fs";
import { open as openFile } from "node:fs/promises";

export async function writeNewImageAttachment(path: string, content: Buffer): Promise<void> {
  const file = await openFile(
    path,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
    0o600
  );
  try {
    await file.writeFile(content);
  } finally {
    await file.close();
  }
}
