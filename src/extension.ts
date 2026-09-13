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
      throw new Error("확장 버전 정보를 읽을 수 없습니다.");
    }
    await services.withProgress({
      location: vscode.ProgressLocation.Notification,
      title: "Agent Factory 플러그인 의존성을 확인하는 중입니다…",
      cancellable: false
    }, () => services.ensurePlugin(requiredVersion));
  } catch (error) {
    const detail = error instanceof Error ? error.message : "알 수 없는 오류가 발생했습니다.";
    await services.showErrorMessage(`Agent Factory를 시작하지 못했습니다. ${detail}`);
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
