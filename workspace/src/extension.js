"use strict";

const { randomBytes } = require("node:crypto");
const { resolve } = require("node:path");
const vscode = require("vscode");

const { createArtifactController } = require("./artifactController");
const { createKanbanController } = require("./kanbanController");
const { createWorkUnitTransitionRunner } = require("./kanbanManager");
const { createWebviewHtml } = require("./webviewShell");

const COMMAND_OPEN_WORKSPACE = "agentFactoryWorkspace.open";
const VIEW_TYPE = "agentFactoryWorkspace.workspace";

let workspacePanel;
let kanbanController;
let artifactController;
let developmentProjectRoot;

function openWorkspacePanel() {
  if (workspacePanel) {
    workspacePanel.reveal(vscode.ViewColumn.Active);
    return workspacePanel;
  }

  workspacePanel = vscode.window.createWebviewPanel(
    VIEW_TYPE,
    "Agent Factory Workspace",
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      localResourceRoots: [],
      retainContextWhenHidden: false,
    },
  );

  workspacePanel.webview.html = createWebviewHtml({
    cspSource: workspacePanel.webview.cspSource,
    nonce: randomBytes(18).toString("base64url"),
  });

  const projectRoot =
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || developmentProjectRoot;
  kanbanController = createKanbanController({
    vscode,
    panel: workspacePanel,
    projectRoot,
    runTransition: createWorkUnitTransitionRunner(),
  });
  artifactController = createArtifactController({
    vscode,
    panel: workspacePanel,
    projectRoot,
  });

  workspacePanel.onDidDispose(() => {
    kanbanController?.dispose();
    kanbanController = undefined;
    artifactController?.dispose();
    artifactController = undefined;
    workspacePanel = undefined;
  });

  return workspacePanel;
}

function activate(context) {
  developmentProjectRoot =
    context.extensionMode === vscode.ExtensionMode.Development
      ? resolve(context.extensionPath, "..")
      : undefined;
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_WORKSPACE, openWorkspacePanel),
  );
}

function deactivate() {
  kanbanController?.dispose();
  kanbanController = undefined;
  artifactController?.dispose();
  artifactController = undefined;
  workspacePanel?.dispose();
  workspacePanel = undefined;
  developmentProjectRoot = undefined;
}

module.exports = {
  COMMAND_OPEN_WORKSPACE,
  VIEW_TYPE,
  activate,
  deactivate,
  openWorkspacePanel,
};
