import { localize, setHostLanguage } from "./common/localization";
import * as vscode from "vscode";
import { bootstrap } from "./core/bootstrap";
import { ensureAgentFactoryPlugin } from "./infrastructure/agent-factory/plugin-dependency";
import { ensureAgentFactoryClaudePlugin } from "./infrastructure/agent-factory/claude-plugin-dependency";
import { developmentPluginRoot, validateDevelopmentPlugin } from "./infrastructure/agent-factory/development-plugin";
import { locateAgentFactoryExec } from "./infrastructure/agent-factory/plugin-locator";
import { CodexCliNotFoundError, configureClaudeCli, configureCodexCli, resolveClaudeCli, resolveCodexCli } from "./infrastructure/agent-factory/process-environment";
import { openWslWorkspace } from "./infrastructure/vscode/wsl-workspace";

export interface ActivationServices {
  readonly prepareCodex?: (configuredPath?: string, options?: { readonly allowRedirect: boolean }) => Promise<void | "redirected">;
  /** Resolves the optional Claude Code CLI; true when Claude can run without Codex. */
  readonly prepareClaude?: (configuredPath?: string) => Promise<boolean>;
  readonly ensurePlugin: (requiredVersion: string) => Promise<void>;
  /** Installs or updates the matching Claude Code plugin when the Claude CLI is available. */
  readonly ensureClaudePlugin?: (requiredVersion: string) => Promise<void>;
  readonly showWarningMessage?: typeof vscode.window.showWarningMessage;
  /** Claude-only hosts cannot install from the Codex marketplace; they need an already installed plugin. */
  readonly requireInstalledPlugin?: (requiredVersion: string) => Promise<void>;
  readonly bootstrap: (context: vscode.ExtensionContext) => void;
  readonly withProgress: typeof vscode.window.withProgress;
  readonly showErrorMessage: typeof vscode.window.showErrorMessage;
  readonly showInformationMessage?: typeof vscode.window.showInformationMessage;
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
      const settings = vscode.workspace?.getConfiguration("agentFactory.mainChat");
      const configuredCodexPath = settings?.get<string>("codexPath")?.trim();
      const claudeAvailable = await services.prepareClaude?.(settings?.get<string>("claudePath")?.trim()) ?? false;
      let codexAvailable = true;
      let prepared: void | "redirected" = undefined;
      try {
        // A usable local Claude CLI makes a WSL redirect for a missing Codex unnecessary.
        prepared = await services.prepareCodex?.(configuredCodexPath, { allowRedirect: !claudeAvailable });
      } catch (error) {
        if (!(error instanceof Error && error.name === "CodexCliNotFoundError") || !claudeAvailable) throw error;
        codexAvailable = false;
      }
      if (prepared === "redirected") {
        recoveryCommands.get(context)?.dispose();
        recoveryCommands.delete(context);
        // The command that triggered activation must still exist in the original window.
        if (services.registerCommand) {
          const disposable = services.registerCommand("agentFactory.mainChat.open", () =>
            services.showInformationMessage?.(localize("ui.wsl.project.opened")));
          context.subscriptions.push(disposable);
        }
        return true;
      }
      await services.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: localize("ui.checking.agent.factory.plugin.dependencies"),
        cancellable: false
      }, async () => {
        if (developmentRoot) return validateDevelopmentPlugin(developmentRoot, requiredVersion);
        if (codexAvailable) await services.ensurePlugin(requiredVersion);
        if (claudeAvailable && services.ensureClaudePlugin) {
          try {
            await services.ensureClaudePlugin(requiredVersion);
          } catch (error) {
            // With Codex present the runtime is already installed; the Claude plugin only adds Claude Code skills.
            if (!codexAvailable) throw error;
            void services.showWarningMessage?.(localize("claude.plugin.warning", error instanceof Error ? error.message : String(error)));
          }
        }
        if (!codexAvailable && services.requireInstalledPlugin) await services.requireInstalledPlugin(requiredVersion);
      });
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
    prepareCodex: async (configuredPath, options) => {
      configureCodexCli(undefined);
      try {
        configureCodexCli(await resolveCodexCli({ configuredPath }));
      } catch (error) {
        if (error instanceof CodexCliNotFoundError && (options?.allowRedirect ?? true) && await openWslWorkspace()) return "redirected";
        throw error;
      }
    },
    prepareClaude: async (configuredPath) => {
      const executable = await resolveClaudeCli({ configuredPath });
      configureClaudeCli(executable);
      return executable !== undefined;
    },
    ensurePlugin: ensureAgentFactoryPlugin,
    ensureClaudePlugin: ensureAgentFactoryClaudePlugin,
    showWarningMessage: vscode.window.showWarningMessage.bind(vscode.window),
    requireInstalledPlugin: async (requiredVersion) => {
      const configuredPath = vscode.workspace?.getConfiguration("agentFactory.mainChat").get<string>("runtimeExecPath")?.trim();
      const location = await locateAgentFactoryExec({ configuredPath, requiredVersion });
      if (!location.available) throw new Error(localize("ui.claude.only.requires.installed.plugin", location.diagnostic));
    },
    bootstrap,
    withProgress: vscode.window.withProgress.bind(vscode.window),
    showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window),
    showInformationMessage: vscode.window.showInformationMessage.bind(vscode.window),
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
