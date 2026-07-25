"use strict";

const vscode = require("vscode");

const {
  CHAT_VIEW_ID,
  AgentsChatViewProvider,
} = require("./chatView");
const { registerWorkspaceExplorer } = require("./explorerTree");

function activate(context) {
  registerWorkspaceExplorer(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      CHAT_VIEW_ID,
      new AgentsChatViewProvider(),
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

