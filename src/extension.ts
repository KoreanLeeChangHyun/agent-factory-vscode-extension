import * as vscode from "vscode";
import { bootstrap } from "./core/bootstrap";
import { ensureAgentFactoryPlugin } from "./infrastructure/agent-factory/plugin-dependency";

export interface ActivationServices {
  readonly ensurePlugin: (requiredVersion: string) => Promise<void>;
  readonly bootstrap: (context: vscode.ExtensionContext) => void;
  readonly withProgress: typeof vscode.window.withProgress;
  readonly showErrorMessage: typeof vscode.window.showErrorMessage;
}

const activations = new WeakMap<vscode.ExtensionContext, Promise<boolean>>();

export function activate(
  context: vscode.ExtensionContext,
  services: ActivationServices = defaultActivationServices()
): Promise<void> {
  const pending = activations.get(context);
  if (pending) return pending.then(() => undefined);
  const activation = start(context, services);
  activations.set(context, activation);
  // Keep successful activation cached so bootstrap registers subscriptions only once.
  void activation.then((started) => {
    if (!started) activations.delete(context);
  }, () => activations.delete(context));
  return activation.then(() => undefined);
}

async function start(context: vscode.ExtensionContext, services: ActivationServices): Promise<boolean> {
  // The activation wrapper owns deduplication across the error notification and Retry.
  while (true) {
    try {
      const requiredVersion: unknown = context.extension.packageJSON.version;
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
      const action = await services.showErrorMessage(
        `Unable to start Agent Factory. ${detail} Check the workspace extension host (SSH, WSL or container when remote), then Retry.`,
        "Retry"
      );
      if (action === "Retry") continue;
      return false;
    }
    services.bootstrap(context);
    return true;
  }
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
