"use strict";

const vscode = require("vscode");

const {
  CHAT_VIEW_ID,
  AgentsChatViewProvider,
} = require("./chatView");
const { AgentsChatController } = require("./chatBackend");
const {
  CodexRunner,
  resolveBundledCodexPath,
} = require("./codexAdapter");
const { registerWorkspaceExplorer } = require("./explorerTree");

function activate(context) {
  registerWorkspaceExplorer(context);
  const executablePath = resolveBundledCodexPath({
    extensionPath: context.extensionPath,
  });
  const runner = new CodexRunner({ executablePath });
  const controller = new AgentsChatController({
    runner,
    workspaceState: context.workspaceState,
    workspaceRoot:
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || context.extensionPath,
  });
  context.subscriptions.push({ dispose: () => runner.dispose() });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      new AgentsChatViewProvider({ controller }),
      {
        webviewOptions: {
          retainContextWhenHidden: true,
        },
      },
    ),
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
};
