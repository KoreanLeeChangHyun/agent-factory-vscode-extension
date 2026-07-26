"use strict";

const { readKanbanSnapshot } = require("./kanbanReader");
const {
  WORK_UNIT_ID_PATTERN,
  createWorkUnitTransitionRunner,
} = require("./kanbanManager");

const ALLOWED_WEBVIEW_MESSAGES = new Set([
  "kanban.ready",
  "kanban.refresh",
  "kanban.transition",
]);
const TRANSITION_KEYS = new Set([
  "type",
  "requestId",
  "workUnitId",
  "fromStatus",
  "targetStatus",
  "snapshotGeneratedAt",
]);

function sanitizeMessage(value, fallback) {
  const message = typeof value === "string" && value ? value : fallback;
  return message
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function findCard(snapshot, workUnitId) {
  for (const column of snapshot?.columns || []) {
    const card = column.cards?.find((candidate) => candidate.id === workUnitId);
    if (card) {
      return card;
    }
  }
  return undefined;
}

function isTransitionMessage(message) {
  return (
    Object.keys(message).every((key) => TRANSITION_KEYS.has(key)) &&
    Object.keys(message).length === TRANSITION_KEYS.size &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.workUnitId === "string" &&
    WORK_UNIT_ID_PATTERN.test(message.workUnitId) &&
    typeof message.fromStatus === "string" &&
    typeof message.targetStatus === "string" &&
    typeof message.snapshotGeneratedAt === "string"
  );
}

function createKanbanController({
  vscode,
  panel,
  projectRoot,
  readSnapshot = readKanbanSnapshot,
  runTransition = createWorkUnitTransitionRunner(),
  debounceMs = 120,
}) {
  let disposed = false;
  let refreshSequence = 0;
  let refreshTimer;
  let currentSnapshot;
  const pendingWorkUnits = new Set();
  const disposables = [];

  async function refresh() {
    const requestId = ++refreshSequence;
    try {
      if (!projectRoot) {
        throw new Error("열린 Workspace Folder가 필요합니다.");
      }
      const snapshot = await readSnapshot(projectRoot);
      if (!disposed && requestId === refreshSequence) {
        currentSnapshot = snapshot;
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

  async function postTransitionFailure(message, code, detail) {
    await panel.webview.postMessage({
      type: "kanban.transitionResult",
      requestId: message.requestId,
      workUnitId: message.workUnitId,
      ok: false,
      error: {
        code,
        message: sanitizeMessage(detail, "상태 전이에 실패했습니다."),
      },
    });
  }

  async function transition(message) {
    if (!isTransitionMessage(message)) {
      return;
    }
    const card = findCard(currentSnapshot, message.workUnitId);
    if (
      !card ||
      currentSnapshot.generatedAt !== message.snapshotGeneratedAt ||
      card.status !== message.fromStatus
    ) {
      await postTransitionFailure(
        message,
        "stale_snapshot",
        "보드가 변경되었습니다. 새로 고침 후 다시 시도하세요.",
      );
      return;
    }
    const capability = card.capabilities?.find(
      (candidate) => candidate.target === message.targetStatus,
    );
    if (!capability?.allowed) {
      await postTransitionFailure(
        message,
        "transition_not_allowed",
        capability?.reason || "현재 상태에서 허용되지 않는 전이입니다.",
      );
      return;
    }
    if (pendingWorkUnits.has(message.workUnitId)) {
      await postTransitionFailure(
        message,
        "transition_pending",
        "이 Work Unit의 상태 전이가 이미 진행 중입니다.",
      );
      return;
    }

    pendingWorkUnits.add(message.workUnitId);
    await panel.webview.postMessage({
      type: "kanban.transitionPending",
      requestId: message.requestId,
      workUnitId: message.workUnitId,
      targetStatus: message.targetStatus,
    });
    try {
      await runTransition({
        projectRoot,
        workUnitId: message.workUnitId,
        targetStatus: message.targetStatus,
      });
      await refresh();
      await panel.webview.postMessage({
        type: "kanban.transitionResult",
        requestId: message.requestId,
        workUnitId: message.workUnitId,
        targetStatus: message.targetStatus,
        ok: true,
      });
    } catch (error) {
      await refresh();
      await postTransitionFailure(
        message,
        error.code || "transition_failed",
        error.message,
      );
    } finally {
      pendingWorkUnits.delete(message.workUnitId);
    }
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
      return message.type === "kanban.transition"
        ? transition(message)
        : refresh();
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
  isTransitionMessage,
};
