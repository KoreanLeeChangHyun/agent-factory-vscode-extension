import { localize, setHostLanguage } from "./common/localization";
import * as vscode from "vscode";
import { bootstrap } from "./core/bootstrap";
import { ensureAgentFactoryPlugin } from "./infrastructure/agent-factory/plugin-dependency";
import { developmentPluginRoot, validateDevelopmentPlugin } from "./infrastructure/agent-factory/development-plugin";
import { configureCodexCli, resolveCodexCli } from "./infrastructure/agent-factory/process-environment";

export interface ActivationServices {
  readonly prepareCodex?: (configuredPath?: string) => Promise<void>;
  readonly ensurePlugin: (requiredVersion: string) => Promise<void>;
  readonly bootstrap: (context: vscode.ExtensionContext) => void;
  readonly withProgress: typeof vscode.window.withProgress;
  readonly showErrorMessage: typeof vscode.window.showErrorMessage;
  readonly registerCommand?: typeof vscode.commands.registerCommand;
}

const activations = new WeakMap<vscode.ExtensionContext, Promise<boolean>>();
const recoveryCommands = new WeakMap<vscode.ExtensionContext, vscode.Disposable>();

export function activate(
  context: vscode.ExtensionContext,
  services: ActivationServices = defaultActivationServices()
): Promise<void> {
  setHostLanguage(vscode.env?.language || "en");
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
        throw new Error(localize("ui.unable.to.read.the.extension.version"));
      }
      const developmentRoot = developmentPluginRoot(context.extensionMode === vscode.ExtensionMode.Development);
      const configuredCodexPath = vscode.workspace?.getConfiguration("agentFactory.mainChat").get<string>("codexPath")?.trim();
      await services.prepareCodex?.(configuredCodexPath);
      await services.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: localize("ui.checking.agent.factory.plugin.dependencies"),
        cancellable: false
      }, () => developmentRoot
        ? validateDevelopmentPlugin(developmentRoot, requiredVersion)
        : services.ensurePlugin(requiredVersion));
    } catch (error) {
      const detail = error instanceof Error ? error.message : localize("ui.an.unknown.error.occurred");
      const action = await services.showErrorMessage(
        localize("ui.unable.to.start.agent.factory.0.check.the.workspace.extension.host.ssh.wsl.or.container.when.remote.then.retry", detail),
        localize("ui.retry")
      );
      if (action === localize("ui.retry")) continue;
      installRecoveryCommand(context, services, detail);
      return false;
    }
    recoveryCommands.get(context)?.dispose();
    recoveryCommands.delete(context);
    services.bootstrap(context);
    return true;
  }
}

export function deactivate(): void {
  // VS Code disposes subscriptions registered on the extension context.
}

function defaultActivationServices(): ActivationServices {
  return {
    prepareCodex: async (configuredPath) => {
      configureCodexCli(undefined);
      configureCodexCli(await resolveCodexCli({ configuredPath }));
    },
    ensurePlugin: ensureAgentFactoryPlugin,
    bootstrap,
    withProgress: vscode.window.withProgress.bind(vscode.window),
    showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window),
    registerCommand: vscode.commands.registerCommand.bind(vscode.commands)
  };
}

function installRecoveryCommand(context: vscode.ExtensionContext, services: ActivationServices, detail: string): void {
  if (!services.registerCommand) return;
  recoveryCommands.get(context)?.dispose();
  const disposable = services.registerCommand("agentFactory.mainChat.open", async () => {
    const action = await services.showErrorMessage(
      localize("ui.agent.factory.is.not.ready.0.correct.the.codex.cli.setting.or.workspace.extension.host.environment.then.retry", detail),
      localize("ui.retry")
    );
    if (action === localize("ui.retry")) await activate(context, services);
  });
  recoveryCommands.set(context, disposable);
}
