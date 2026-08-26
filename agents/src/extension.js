"use strict";

const vscode = require("vscode");

const { createAgentsPanelManager } = require("./agentsPanel");
const { AgentsChatController } = require("./chatBackend");
const {
  CodexRunner,
  resolveBundledCodexPath,
} = require("./codexAdapter");
const { registerLauncher } = require("./launcher");
const { StatusMetadataReader } = require("./statusMetadata");

const COMMAND_OPEN_AGENTS = "agentFactoryAgents.open";

function activate(context) {
  registerLauncher(vscode, context);
  const executablePath = resolveBundledCodexPath({
    extensionPath: context.extensionPath,
  });
  const runner = new CodexRunner({ executablePath });
  const workspaceRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath;
  const metadataReader = new StatusMetadataReader({
    executablePath,
    workspaceRoot,
  });
  const controller = new AgentsChatController({
    runner,
    workspaceState: context.workspaceState,
    workspaceRoot,
    metadataReader,
  });
  context.subscriptions.push({ dispose: () => runner.dispose() });
  const panelManager = createAgentsPanelManager({ vscode, controller });
  context.subscriptions.push(
    panelManager,
    vscode.commands.registerCommand(
      COMMAND_OPEN_AGENTS,
      panelManager.open,
    ),
  );
}

function deactivate() {}

module.exports = {
  COMMAND_OPEN_AGENTS,
  activate,
  deactivate,
};
