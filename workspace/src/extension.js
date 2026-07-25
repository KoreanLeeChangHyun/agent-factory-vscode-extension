"use strict";

const { randomBytes } = require("node:crypto");
const vscode = require("vscode");

const { createWebviewHtml } = require("./webviewShell");

const COMMAND_OPEN_WORKSPACE = "agentFactoryWorkspace.open";
const VIEW_TYPE = "agentFactoryWorkspace.workspace";

let workspacePanel;

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

  workspacePanel.onDidDispose(() => {
    workspacePanel = undefined;
  });

  return workspacePanel;
}

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMAND_OPEN_WORKSPACE, openWorkspacePanel),
  );
}

function deactivate() {
  workspacePanel?.dispose();
  workspacePanel = undefined;
}

module.exports = {
  COMMAND_OPEN_WORKSPACE,
  VIEW_TYPE,
  activate,
  deactivate,
  openWorkspacePanel,
};
