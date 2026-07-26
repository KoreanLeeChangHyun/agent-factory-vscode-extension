"use strict";

const { readKanbanSnapshot } = require("./kanbanReader");

const ALLOWED_WEBVIEW_MESSAGES = new Set(["kanban.ready", "kanban.refresh"]);

function createKanbanController({
  vscode,
  panel,
  projectRoot,
  readSnapshot = readKanbanSnapshot,
  debounceMs = 120,
}) {
  let disposed = false;
  let refreshSequence = 0;
  let refreshTimer;
  const disposables = [];

  async function refresh() {
    const requestId = ++refreshSequence;
    try {
      if (!projectRoot) {
        throw new Error("열린 Workspace Folder가 필요합니다.");
      }
      const snapshot = await readSnapshot(projectRoot);
      if (!disposed && requestId === refreshSequence) {
        await panel.webview.postMessage({
          type: "kanban.snapshot",
          requestId,
          snapshot,
        });
      }
    } catch (error) {
      if (!disposed && requestId === refreshSequence) {
        await panel.webview.postMessage({
          type: "kanban.error",
          requestId,
          error: {
            code: error.code || "snapshot_failed",
            message: error.message || "Kanban snapshot을 읽지 못했습니다.",
          },
        });
      }
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refresh, debounceMs);
  }

  disposables.push(
    panel.webview.onDidReceiveMessage((message) => {
      if (
        !message ||
        typeof message !== "object" ||
        !ALLOWED_WEBVIEW_MESSAGES.has(message.type)
      ) {
        return undefined;
      }
      return refresh();
    }),
  );

  if (projectRoot) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        projectRoot,
        ".agent-factory/work-units/**/*.json",
      ),
    );
    disposables.push(
      watcher.onDidChange(scheduleRefresh),
      watcher.onDidCreate(scheduleRefresh),
      watcher.onDidDelete(scheduleRefresh),
      watcher,
    );
  }

  return {
    dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      clearTimeout(refreshTimer);
      for (const disposable of disposables) {
        disposable.dispose();
      }
    },
    refresh,
  };
}

module.exports = {
  ALLOWED_WEBVIEW_MESSAGES,
  createKanbanController,
};
