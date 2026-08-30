import type * as vscode from "vscode";
import { bootstrap } from "./core/bootstrap";

export function activate(context: vscode.ExtensionContext): void {
  bootstrap(context);
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}
