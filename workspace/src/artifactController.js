"use strict";

const {
  ARTIFACT_DEFINITIONS,
  ARTIFACT_ID_PATTERN,
  readArtifactDocument,
  readArtifactIndex,
} = require("./artifactReader");
const { createArtifactItemSaveRunner } = require("./artifactManager");

const ALLOWED_WEBVIEW_MESSAGES = new Set([
  "artifact.ready",
  "artifact.refresh",
  "artifact.select",
  "artifact.saveItem",
]);
const SELECT_KEYS = new Set(["type", "artifactType", "artifactId"]);
const SAVE_KEYS = new Set([
  "type",
  "requestId",
  "artifactType",
  "artifactId",
  "sectionId",
  "itemId",
  "documentVersion",
  "content",
]);
const SECTION_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ITEM_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function hasExactKeys(message, keys) {
  const actual = Object.keys(message);
  return actual.length === keys.size && actual.every((key) => keys.has(key));
}

function isArtifactIdentity(message) {
  return (
    Object.hasOwn(ARTIFACT_DEFINITIONS, message.artifactType) &&
    typeof message.artifactId === "string" &&
    ARTIFACT_ID_PATTERN.test(message.artifactId)
  );
}

function isArtifactSelectMessage(message) {
  return (
    hasExactKeys(message, SELECT_KEYS) &&
    message.type === "artifact.select" &&
    isArtifactIdentity(message)
  );
}

function isArtifactSaveMessage(message) {
  return (
    hasExactKeys(message, SAVE_KEYS) &&
    message.type === "artifact.saveItem" &&
    isArtifactIdentity(message) &&
    typeof message.requestId === "string" &&
    message.requestId.length > 0 &&
    message.requestId.length <= 128 &&
    typeof message.sectionId === "string" &&
    SECTION_ID_PATTERN.test(message.sectionId) &&
    typeof message.itemId === "string" &&
    ITEM_ID_PATTERN.test(message.itemId) &&
    typeof message.documentVersion === "string" &&
    message.documentVersion.length <= 64 &&
    Object.hasOwn(message, "content")
  );
}

function sanitizeMessage(value, fallback) {
  const message = typeof value === "string" && value ? value : fallback;
  return message
    .replace(/[\u0000-\u001f\u007f<>]/g, " ")
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

function publicDocument(document) {
  const { packagePath: _packagePath, ...safeDocument } = document;
  return safeDocument;
}

function publicIndex(index) {
  const { projectRoot: _projectRoot, ...safeIndex } = index;
  return safeIndex;
}

function createArtifactController({
  vscode,
  panel,
  projectRoot,
  readIndex = readArtifactIndex,
  readDocument = readArtifactDocument,
  saveItem = createArtifactItemSaveRunner(),
  debounceMs = 120,
}) {
  let disposed = false;
  let refreshTimer;
  const pending = new Set();
  const disposables = [];

  async function refreshIndex() {
    try {
      if (!projectRoot) {
        throw new Error("열린 Workspace Folder가 필요합니다.");
      }
      const index = await readIndex(projectRoot);
      if (!disposed) {
        await panel.webview.postMessage({
          type: "artifact.index",
          index: publicIndex(index),
        });
      }
    } catch (error) {
      if (!disposed) {
        await panel.webview.postMessage({
          type: "artifact.error",
          error: {
            code: error.code || "index_failed",
            message: sanitizeMessage(
              error.message,
              "artifact 목록을 읽지 못했습니다.",
            ),
          },
        });
      }
    }
  }

  async function select(message) {
    if (!isArtifactSelectMessage(message)) {
      return;
    }
    try {
      const document = await readDocument(
        projectRoot,
        message.artifactType,
        message.artifactId,
      );
      if (!disposed) {
        await panel.webview.postMessage({
          type: "artifact.document",
          document: publicDocument(document),
        });
      }
    } catch (error) {
      if (!disposed) {
        await panel.webview.postMessage({
          type: "artifact.error",
          error: {
            code: error.code || "document_failed",
            message: sanitizeMessage(
              error.message,
              "artifact를 읽지 못했습니다.",
            ),
          },
        });
      }
    }
  }

  async function save(message) {
    if (!isArtifactSaveMessage(message)) {
      return;
    }
    const key = `${message.artifactType}:${message.artifactId}`;
    if (pending.has(key)) {
      return;
    }
    pending.add(key);
    await panel.webview.postMessage({
      type: "artifact.savePending",
      requestId: message.requestId,
      artifactType: message.artifactType,
      artifactId: message.artifactId,
    });
    try {
      const document = await saveItem({ ...message, projectRoot });
      await panel.webview.postMessage({
        type: "artifact.document",
        document: publicDocument(document),
      });
      await panel.webview.postMessage({
        type: "artifact.saveResult",
        requestId: message.requestId,
        ok: true,
      });
    } catch (error) {
      await select({
        type: "artifact.select",
        artifactType: message.artifactType,
        artifactId: message.artifactId,
      });
      await panel.webview.postMessage({
        type: "artifact.saveResult",
        requestId: message.requestId,
        ok: false,
        error: {
          code: error.code || "save_failed",
          message: sanitizeMessage(error.message, "artifact 저장에 실패했습니다."),
        },
      });
    } finally {
      pending.delete(key);
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(refreshIndex, debounceMs);
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
      if (message.type === "artifact.select") {
        return select(message);
      }
      if (message.type === "artifact.saveItem") {
        return save(message);
      }
      return refreshIndex();
    }),
  );
  if (projectRoot) {
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        projectRoot,
        ".agent-factory/{intakes,specifications,work-units}/**/*.json",
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
    refresh: refreshIndex,
  };
}

module.exports = {
  ALLOWED_WEBVIEW_MESSAGES,
  createArtifactController,
  isArtifactSaveMessage,
  isArtifactSelectMessage,
  publicDocument,
  publicIndex,
};
