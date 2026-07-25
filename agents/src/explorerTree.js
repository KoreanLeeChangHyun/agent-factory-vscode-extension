"use strict";

const vscode = require("vscode");

const { createExplorerEntries } = require("./explorerModel");

class WorkspaceExplorerProvider {
  constructor() {
    this.changeEmitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.changeEmitter.event;
  }

  refresh() {
    this.changeEmitter.fire(undefined);
  }

  getTreeItem(node) {
    const isDirectory = node.type === "directory";
    const item = new vscode.TreeItem(
      node.label,
      isDirectory
        ? vscode.TreeItemCollapsibleState.Collapsed
        : vscode.TreeItemCollapsibleState.None,
    );
    item.resourceUri = node.uri;
    item.contextValue = isDirectory
      ? "agentFactoryAgents.directory"
      : "agentFactoryAgents.file";
    item.tooltip = node.uri.fsPath;
    return item;
  }

  async getChildren(node) {
    if (!node) {
      return (vscode.workspace.workspaceFolders || []).map((folder) => ({
        label: folder.name,
        name: folder.name,
        type: "directory",
        uri: folder.uri,
      }));
    }

    if (node.type !== "directory") {
      return [];
    }

    const entries = await vscode.workspace.fs.readDirectory(node.uri);
    return createExplorerEntries(entries).map((entry) => ({
      ...entry,
      label: entry.name,
      uri: vscode.Uri.joinPath(node.uri, entry.name),
    }));
  }

  dispose() {
    this.changeEmitter.dispose();
  }
}

function registerWorkspaceExplorer(context) {
  const provider = new WorkspaceExplorerProvider();
  const tree = vscode.window.createTreeView(
    "agentFactoryAgents.explorer",
    {
      treeDataProvider: provider,
      showCollapseAll: true,
    },
  );
  const workspaceFoldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(
    () => provider.refresh(),
  );

  context.subscriptions.push(provider, tree, workspaceFoldersSubscription);
  return provider;
}

module.exports = {
  WorkspaceExplorerProvider,
  registerWorkspaceExplorer,
};

