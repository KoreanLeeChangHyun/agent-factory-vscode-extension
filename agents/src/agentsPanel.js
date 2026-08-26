"use strict";

const { randomBytes } = require("node:crypto");

const { configureChatWebview } = require("./chatView");

const AGENTS_PANEL_VIEW_TYPE = "agentFactoryAgents.panel";

function createAgentsPanelManager({
  vscode,
  controller,
  createNonce = () => randomBytes(18).toString("base64url"),
}) {
  let panel;
  let chatBinding;

  function open() {
    if (panel) {
      panel.reveal(vscode.ViewColumn.Active);
      return panel;
    }

    panel = vscode.window.createWebviewPanel(
      AGENTS_PANEL_VIEW_TYPE,
      "Agent Factory Agents",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [],
        retainContextWhenHidden: false,
      },
    );
    chatBinding = configureChatWebview({
      vscode,
      webview: panel.webview,
      controller,
      nonce: createNonce(),
    });

    const currentPanel = panel;
    panel.onDidDispose(() => {
      if (panel !== currentPanel) return;
      chatBinding?.dispose();
      chatBinding = undefined;
      panel = undefined;
    });
    return panel;
  }

  function dispose() {
    panel?.dispose();
    chatBinding?.dispose();
    chatBinding = undefined;
    panel = undefined;
  }

  return { dispose, open };
}

module.exports = {
  AGENTS_PANEL_VIEW_TYPE,
  createAgentsPanelManager,
};
