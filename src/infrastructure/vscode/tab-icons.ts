import { copyFile, mkdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import * as vscode from "vscode";
import { FRAME_COUNT } from "./running-title";

export const TAB_ICON_FILES = ["agent-factory.png", ...Array.from({ length: FRAME_COUNT }, (_, frame) => `loading-squares-${frame}.svg`)];

/**
 * VS Code restores background webview tabs with the icon URI saved at shutdown and revives
 * them only when shown. Bundled URIs contain the extension version, so an update that removes
 * the previous folder leaves those tabs without an icon; global storage survives updates.
 */
export async function prepareTabIcons(extensionUri: vscode.Uri, storageUri: vscode.Uri | undefined): Promise<vscode.Uri> {
  const bundled = vscode.Uri.joinPath(extensionUri, "static", "images");
  if (!storageUri) return bundled;
  try {
    const stable = vscode.Uri.joinPath(storageUri, "tab-icons");
    await mkdir(stable.fsPath, { recursive: true });
    for (const name of TAB_ICON_FILES) {
      const source = join(bundled.fsPath, name), target = join(stable.fsPath, name);
      const expected = await readFile(source);
      if (await readFile(target).then(current => current.equals(expected), () => false)) continue;
      const temporary = `${target}.${process.pid}.tmp`;
      await copyFile(source, temporary);
      await rename(temporary, target);
    }
    return stable;
  } catch {
    return bundled;
  }
}
