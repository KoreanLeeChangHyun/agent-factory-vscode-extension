"use strict";

const LAUNCHER_VIEW_ID = "agentFactoryAgents.launcher";

class EmptyLauncherProvider {
  getTreeItem(item) {
    return item;
  }

  getChildren() {
    return [];
  }
}

function registerLauncher(vscode, context) {
  const provider = new EmptyLauncherProvider();
  const registration = vscode.window.registerTreeDataProvider(
    LAUNCHER_VIEW_ID,
    provider,
  );
  context.subscriptions.push(registration);
  return provider;
}

module.exports = {
  EmptyLauncherProvider,
  LAUNCHER_VIEW_ID,
  registerLauncher,
};
