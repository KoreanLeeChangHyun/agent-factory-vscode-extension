import { disposeCodexConnections } from "./infrastructure/agent-factory/codex-connection-host";
import { localize, setHostLanguage } from "./common/localization";
import * as vscode from "vscode";
import { bootstrap } from "./core/bootstrap";
import { ensureAgentFactoryCodexRuntime } from "./infrastructure/agent-factory/codex-plugin-setup";
import { ensureAgentFactoryClaudePlugin } from "./infrastructure/agent-factory/claude-plugin-dependency";
import { ensureAgentFactoryAntigravityPlugin } from "./infrastructure/agent-factory/antigravity-plugin-dependency";
import { developmentPluginRoot, runtimeExecOverride, validateDevelopmentPlugin } from "./infrastructure/agent-factory/development-plugin";
import { locateAgentFactoryExec } from "./infrastructure/agent-factory/plugin-locator";
import { detectProviders } from "./infrastructure/agent-factory/provider-detection";
import { configuredDevelopmentPluginRoot, configuredProviderPaths } from "./infrastructure/vscode/provider-settings";
import { openWslWorkspace } from "./infrastructure/vscode/wsl-workspace";
import { initializeAgentDefaults } from "./infrastructure/vscode/agent-settings-store";

export interface ProviderAvailability {
  readonly codex: boolean;
  readonly claude: boolean;
  readonly antigravity: boolean;
}

export interface ActivationServices {
  readonly initializeDefaults?: (context: vscode.ExtensionContext, providers: { codex: boolean; claude: boolean; antigravity: boolean }) => Promise<void>;
  /** Resolves every provider CLI; a missing one is reported, never thrown. Without it Codex is assumed. */
  readonly detectProviders?: () => Promise<ProviderAvailability>;
  /** Opens the workspace in WSL when no provider CLI exists on this host; true when handed off. */
  readonly redirectToWsl?: () => Promise<boolean>;
  readonly ensurePlugin: (requiredVersion: string) => Promise<void>;
  /** Installs or updates the matching Claude Code plugin when the Claude CLI is available. */
  readonly ensureClaudePlugin?: (requiredVersion: string) => Promise<void>;
  /** Installs or updates the matching Antigravity plugin; blocks startup only when agy is the sole provider. */
  readonly ensureAntigravityPlugin?: (requiredVersion: string) => Promise<void>;
  readonly showWarningMessage?: typeof vscode.window.showWarningMessage;
  /** Claude-only hosts cannot install from the Codex marketplace; they need an already installed plugin. */
  readonly requireInstalledPlugin?: (requiredVersion: string, isDevelopment: boolean) => Promise<void>;
  readonly bootstrap: (context: vscode.ExtensionContext) => void;
  readonly withProgress: typeof vscode.window.withProgress;
  readonly showErrorMessage: typeof vscode.window.showErrorMessage;
  readonly showInformationMessage?: typeof vscode.window.showInformationMessage;
  readonly registerCommand?: typeof vscode.commands.registerCommand;
  /** Claims the sidebar view before the slow dependency checks so it never shows a missing provider. */
  readonly createStartupView?: () => StartupView;
}

export interface StartupView extends vscode.Disposable {
  message: string | undefined;
}

const activations = new WeakMap<vscode.ExtensionContext, Promise<boolean>>();
const recoveryCommands = new WeakMap<vscode.ExtensionContext, vscode.Disposable>();
const startupViews = new WeakMap<vscode.ExtensionContext, StartupView>();

export function activate(
  context: vscode.ExtensionContext,
  services: ActivationServices = defaultActivationServices()
): Promise<void> {
  setHostLanguage(vscode.env?.language || "en");
  const pending = activations.get(context);
  if (pending) return pending.then(() => undefined);
  if (!startupViews.has(context) && services.createStartupView) {
    const view = services.createStartupView();
    view.message = localize("ui.sidebar.starting");
    startupViews.set(context, view);
    context.subscriptions?.push(view);
  }
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
      const developmentRoot = developmentPluginRoot(context.extensionMode === vscode.ExtensionMode.Development, process.env, configuredDevelopmentPluginRoot());
      const providers = await services.detectProviders?.() ?? { codex: true, claude: false, antigravity: false };
      const codexAvailable = providers.codex, claudeAvailable = providers.claude, antigravityAvailable = providers.antigravity;
      const anyProvider = codexAvailable || claudeAvailable || antigravityAvailable;
      // Any local provider CLI makes a WSL redirect unnecessary.
      if (!anyProvider && await services.redirectToWsl?.()) {
        recoveryCommands.get(context)?.dispose();
        recoveryCommands.delete(context);
        setStartupMessage(context, localize("ui.wsl.project.opened"));
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
        if (developmentRoot) {
          try {
            await validateDevelopmentPlugin(developmentRoot);
          } catch (error) {
            void services.showWarningMessage?.(pluginDependencyWarning(error));
          }
          return;
        }
        // Without any CLI the chat still opens; Settings can set paths and install the plugin later.
        if (!anyProvider) return;
        if (codexAvailable) {
          try {
            await services.ensurePlugin(requiredVersion);
          } catch (error) {
            void services.showWarningMessage?.(pluginDependencyWarning(error));
          }
        }
        if (claudeAvailable && services.ensureClaudePlugin) {
          try {
            await services.ensureClaudePlugin(requiredVersion);
          } catch (error) {
            // With Codex present the runtime is already installed; the Claude plugin only adds Claude Code skills.
            void services.showWarningMessage?.(localize("claude.plugin.warning", error instanceof Error ? error.message : String(error)));
          }
        }
        // Antigravity is the only installer on an agy-only host, so the runtime must wait for it.
        if (!codexAvailable && !claudeAvailable && services.ensureAntigravityPlugin) {
          try {
            await services.ensureAntigravityPlugin(requiredVersion);
          } catch (error) {
            void services.showWarningMessage?.(pluginDependencyWarning(error));
          }
        }
        if (!codexAvailable && services.requireInstalledPlugin) {
          try {
            await services.requireInstalledPlugin(requiredVersion, context.extensionMode === vscode.ExtensionMode.Development);
          } catch (error) {
            void services.showWarningMessage?.(pluginDependencyWarning(error));
          }
        }
      });
      if (!anyProvider) void services.showWarningMessage?.(localize("ui.providers.none.detected"));
      if (!developmentRoot && antigravityAvailable && (codexAvailable || claudeAvailable) && services.ensureAntigravityPlugin) {
        // Optional host: its GitHub install must not delay or fail the chat's own startup.
        void services.ensureAntigravityPlugin(requiredVersion).catch(error =>
          services.showWarningMessage?.(localize("antigravity.plugin.warning", error instanceof Error ? error.message : String(error))));
      }
      await services.initializeDefaults?.(context, { codex: codexAvailable, claude: claudeAvailable, antigravity: antigravityAvailable });
    } catch (error) {
      const detail = error instanceof Error ? error.message : localize("ui.an.unknown.error.occurred");
      const action = await services.showErrorMessage(
        localize("ui.unable.to.start.agent.factory.0.check.the.workspace.extension.host.ssh.wsl.or.container.when.remote.then.retry", detail),
        localize("ui.retry")
      );
      if (action === localize("ui.retry")) continue;
      installRecoveryCommand(context, services, detail);
      setStartupMessage(context, localize("ui.sidebar.startup.failed", detail));
      return false;
    }
    recoveryCommands.get(context)?.dispose();
    recoveryCommands.delete(context);
    // The real sidebar registers the same view ID, so the placeholder must release it first.
    startupViews.get(context)?.dispose();
    startupViews.delete(context);
    services.bootstrap(context);
    return true;
  }
}

function pluginDependencyWarning(error: unknown): string {
  return localize("ui.plugin.dependency.warning", error instanceof Error ? error.message : String(error));
}

export function deactivate(): void {
  disposeCodexConnections();
  // VS Code disposes subscriptions registered on the extension context.
}

function setStartupMessage(context: vscode.ExtensionContext, message: string): void {
  const view = startupViews.get(context);
  if (view) view.message = message;
}

function createStartupView(): StartupView {
  const view = vscode.window.createTreeView<never>("agentFactory.agents", {
    treeDataProvider: { getTreeItem: item => item, getChildren: () => [] }
  });
  return {
    get message() { return view.message; },
    set message(value) { view.message = value; },
    dispose: () => view.dispose()
  };
}

function defaultActivationServices(): ActivationServices {
  return {
    initializeDefaults: async (context, providers) => initializeAgentDefaults(context.globalState, providers, context.workspaceState),
    detectProviders: async () => {
      const statuses = await detectProviders(configuredProviderPaths());
      const detected = (id: string) => statuses.some(status => status.id === id && status.detected);
      return { codex: detected("codex"), claude: detected("claude"), antigravity: detected("antigravity") };
    },
    redirectToWsl: openWslWorkspace,
    ensurePlugin: ensureAgentFactoryCodexRuntime,
    ensureClaudePlugin: ensureAgentFactoryClaudePlugin,
    ensureAntigravityPlugin: (requiredVersion) => ensureAgentFactoryAntigravityPlugin(requiredVersion),
    showWarningMessage: vscode.window.showWarningMessage.bind(vscode.window),
    requireInstalledPlugin: async (requiredVersion, isDevelopment) => {
      // The F5 root returned before this check, so only the development-host override can apply, as in the chat connection.
      const configuredPath = runtimeExecOverride(isDevelopment, undefined,
        vscode.workspace?.getConfiguration("agentFactory.mainChat").get<string>("runtimeExecPath"));
      const location = await locateAgentFactoryExec({ configuredPath, requiredVersion });
      if (!location.available) throw new Error(localize("ui.claude.only.requires.installed.plugin", location.diagnostic));
    },
    bootstrap,
    withProgress: vscode.window.withProgress.bind(vscode.window),
    showErrorMessage: vscode.window.showErrorMessage.bind(vscode.window),
    showInformationMessage: vscode.window.showInformationMessage.bind(vscode.window),
    registerCommand: vscode.commands.registerCommand.bind(vscode.commands),
    createStartupView
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
