import * as vscode from "vscode";
import { bootstrap } from "./core/bootstrap";
import { ensureAgentFactoryPlugin } from "./infrastructure/agent-factory/plugin-dependency";

export interface ActivationServices {
  readonly ensurePlugin: (requiredVersion: string) => Promise<void>;
  readonly bootstrap: (context: vscode.ExtensionContext) => void;
  readonly withProgress: typeof vscode.window.withProgress;
  readonly showErrorMessage: typeof vscode.window.showErrorMessage;
}

export async function activate(
  context: vscode.ExtensionContext,
  services: ActivationServices = defaultActivationServices()
): Promise<void> {
  const requiredVersion: unknown = context.extension.packageJSON.version;
  try {
    if (typeof requiredVersion !== "string" || !requiredVersion.trim()) {
      throw new Error("Unable to read the extension version.");
    }
    await services.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Checking Agent Factory plugin dependencies…",
      cancellable: false
    }, () => services.ensurePlugin(requiredVersion));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "An unknown error occurred.";
    await services.showErrorMessage(`Unable to start Agent Factory. ${detail}`);
    return;
  }
  services.bootstrap(context);
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}

function defaultActivationServices(): ActivationServices {
  return {
    ensurePlugin: ensureAgentFactoryPlugin,
    bootstrap,
    withProgress: vscode.window.withProgress.bind(vscode.window),
    showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window)
  };
}
