import * as vscode from "vscode";
import { localize } from "../../common/localization";
import { discoverWslWorkspace } from "../agent-factory/wsl-discovery";

/** Native Windows fallback only. Opening a remote URI moves all runtime ownership into WSL. */
export async function openWslWorkspace(
  discover = discoverWslWorkspace,
  platform = process.platform
): Promise<boolean> {
  if (platform !== "win32" || vscode.env.remoteName) return false;
  const folders = vscode.workspace.workspaceFolders;
  // Do not silently discard roots or workspace-file settings during an automatic handoff.
  if (vscode.workspace.workspaceFile || folders?.length !== 1 || folders[0]!.uri.scheme !== "file") return false;
  const target = await discover(folders[0]!.uri.fsPath);
  if (!target) return false;
  if (!vscode.extensions.getExtension("ms-vscode-remote.remote-wsl")) {
    throw new Error(localize("ui.wsl.extension.required", target.distribution));
  }
  const uri = vscode.Uri.from({ scheme: "vscode-remote", authority: `wsl+${target.distribution}`, path: target.path });
  // A new window preserves unsaved work in the Windows window.
  await vscode.commands.executeCommand("vscode.openFolder", uri, { forceNewWindow: true });
  return true;
}
