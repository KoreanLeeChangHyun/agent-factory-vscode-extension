"use strict";

const { randomBytes } = require("node:crypto");
const { writeFile, unlink } = require("node:fs/promises");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

function configureChatWebview({
  vscode,
  webview,
  controller,
  nonce = randomBytes(18).toString("base64url"),
}) {
  webview.options = {
    enableScripts: true,
    localResourceRoots: [],
  };
  webview.html = createChatViewHtml({
    cspSource: webview.cspSource,
    nonce,
  });
  controller.setPostMessage((message) => webview.postMessage(message));
  const pendingImages = new Map();
  const temporaryImages = new Set();

  function removeSessionImages(sessionId) {
    const images = pendingImages.get(sessionId) || [];
    pendingImages.delete(sessionId);
    for (const imagePath of images) {
      temporaryImages.delete(imagePath);
      void unlink(imagePath).catch(() => {});
    }
  }

  const messageSubscription = webview.onDidReceiveMessage(async (message) => {
    if (message?.type === "chat.image.paste" && typeof message.sessionId === "string") {
      const pasted = Array.isArray(message.images) ? message.images.slice(0, 10) : [];
      const images = pendingImages.get(message.sessionId) || [];
      const selected = [];
      for (const image of pasted) {
        if (
          !image ||
          !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.type) ||
          !Array.isArray(image.data) ||
          image.data.length > 20 * 1024 * 1024
        ) {
          continue;
        }
        const extension = image.type === "image/jpeg" ? "jpg" : image.type.split("/")[1];
        const imagePath = join(
          tmpdir(),
          "agent-factory-" + randomBytes(12).toString("hex") + "." + extension,
        );
        const imageBuffer = Buffer.from(image.data);
        await writeFile(imagePath, imageBuffer);
        images.push(imagePath);
        temporaryImages.add(imagePath);
        selected.push({
          name: image.name || "clipboard." + extension,
          preview: "data:" + image.type + ";base64," + imageBuffer.toString("base64"),
        });
      }
      if (!selected.length) return;
      pendingImages.set(message.sessionId, images);
      await webview.postMessage({
        type: "chat.images.selected",
        sessionId: message.sessionId,
        images: selected,
        append: true,
      });
      return;
    }
    if (message?.type === "chat.images.clear" && typeof message.sessionId === "string") {
      removeSessionImages(message.sessionId);
      return;
    }
    if (
      message?.type === "chat.image.remove" &&
      typeof message.sessionId === "string" &&
      Number.isInteger(message.index)
    ) {
      const images = pendingImages.get(message.sessionId) || [];
      const removed = images.splice(message.index, 1)[0];
      if (removed) {
        temporaryImages.delete(removed);
        void unlink(removed).catch(() => {});
      }
      pendingImages.set(message.sessionId, images);
      return;
    }
    if (message?.type === "chat.submit" && typeof message.sessionId === "string") {
      const images = pendingImages.get(message.sessionId) || [];
      const handled = await controller.handleMessage({ ...message, images });
      if (handled) pendingImages.delete(message.sessionId);
      return;
    }
    await controller.handleMessage(message);
  });

  return {
    dispose() {
      messageSubscription.dispose();
      pendingImages.clear();
      for (const imagePath of temporaryImages) {
        void unlink(imagePath).catch(() => {});
      }
      temporaryImages.clear();
      controller.setPostMessage(async () => {});
    },
  };
}

function groupMessagesIntoTurns(messages) {
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    const previousTurn = turns.at(-1);
    const joinsPreviousUser =
      message?.role === "assistant" &&
      previousTurn?.[0]?.role === "user" &&
      !previousTurn.some((item) => item.role === "assistant");

    if (joinsPreviousUser) {
      previousTurn.push(message);
    } else {
      turns.push([message]);
    }
  }

  return turns;
}

function shouldSubmitComposerKey(event) {
  return (
    event?.key === "Enter" &&
    !event.shiftKey &&
    !event.isComposing
  );
}

function resizeComposerInput(element) {
  element.style.height = "auto";
  const height = Math.min(Math.max(element.scrollHeight, 20), 144);
  element.style.height = height + "px";
  element.style.overflowY = element.scrollHeight > 144 ? "auto" : "hidden";
}

function createChatViewHtml({ cspSource, nonce }) {
  if (!cspSource || !nonce) {
    throw new TypeError("cspSource and nonce are required");
  }

  return `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    >
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Factory Agents</title>
    <style>
      :root {
        color-scheme: light dark;
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }

      * { box-sizing: border-box; }

      body {
        min-width: 220px;
        min-height: 100vh;
        margin: 0;
        padding: 0;
        overflow: hidden;
        background: var(--vscode-editor-background);
      }

      button, select, textarea { font: inherit; }
      button { color: inherit; }

      .chat-shell {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr) auto auto;
        min-height: 100vh;
      }

      .mode-tabs {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        min-width: 0;
        padding: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorGroupHeader-tabsBackground);
      }

      .mode-tab {
        position: relative;
        display: flex;
        min-width: 0;
        min-height: 40px;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 8px 8px;
        overflow: hidden;
        border: 0;
        background: var(--vscode-tab-inactiveBackground);
        color: var(--vscode-tab-inactiveForeground);
        cursor: pointer;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .mode-tab[aria-selected="true"] {
        background: var(--vscode-tab-activeBackground);
        color: var(--vscode-tab-activeForeground);
      }

      .mode-tab-indicator {
        position: absolute;
        right: 8px;
        bottom: 0;
        left: 8px;
        height: 2px;
        background: transparent;
        pointer-events: none;
      }

      .mode-tab[aria-selected="true"] .mode-tab-indicator {
        background: var(--vscode-tab-activeBorder, var(--vscode-focusBorder));
      }

      .mode-tab:hover,
      .new-session:hover,
      .composer-action:hover:not(:disabled) {
        background: var(--vscode-toolbar-hoverBackground);
      }

      .mode-tab:focus-visible,
      .session-tab:focus-visible,
      .new-session:focus-visible,
      .composer-action:focus-visible,
      .composer-card:focus-within {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      svg {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-width: 1.5;
        stroke-linecap: round;
        stroke-linejoin: round;
      }

      .session-header {
        display: flex;
        min-width: 0;
        min-height: 32px;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
      }

      .session-tabs {
        display: flex;
        flex: 1 1 auto;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: thin;
      }

      .session-tab {
        display: flex;
        align-items: center;
        gap: 6px;
        flex: 0 0 auto;
        min-width: 104px;
        max-width: 184px;
        padding: 0 8px;
        overflow: hidden;
        border: 0;
        border-right: 1px solid var(--vscode-panel-border);
        background: var(--vscode-tab-inactiveBackground);
        color: var(--vscode-tab-inactiveForeground);
        cursor: pointer;
        white-space: nowrap;
      }

      .session-tab-label {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .session-kind {
        color: var(--vscode-descriptionForeground);
        font-size: 10px;
      }

      .session-close {
        width: 18px;
        height: 18px;
        margin-left: auto;
        padding: 0;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
      }

      .session-close:hover { background: var(--vscode-toolbar-hoverBackground); }

      .session-tab[aria-selected="true"] {
        background: var(--vscode-tab-activeBackground);
        color: var(--vscode-tab-activeForeground);
      }

      .new-session {
        display: grid;
        flex: 0 0 32px;
        width: 32px;
        padding: 0;
        place-items: center;
        border: 0;
        background: transparent;
        cursor: pointer;
      }

      .session-menu { margin-left: auto; }

      .mode-panel {
        min-height: 0;
        padding: 0;
        overflow: auto;
      }

      .messages {
        display: flex;
        min-height: 100%;
        flex-direction: column;
        gap: 8px;
        padding: 10px 12px;
      }

      .empty-state {
        margin: auto;
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
        text-align: center;
      }

      .message {
        width: 100%;
        max-width: 100%;
        padding: 7px 0;
        border: 0;
        border-radius: 0;
        background: transparent;
        color: var(--vscode-foreground);
        font-size: 12px;
        line-height: 1.35;
        overflow-wrap: anywhere;
        white-space: pre-wrap;
      }

      .message-turn {
        display: grid;
        gap: 2px;
      }

      .message-user {
        align-self: flex-start;
        margin-top: 8px;
        padding: 7px 9px;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 4px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
      }

      .message-assistant {
        align-self: flex-start;
        padding: 7px 0;
        border: 0;
        background: transparent;
        color: var(--vscode-foreground);
      }

      .session-status {
        display: flex;
        height: 22px;
        align-items: center;
        gap: 5px;
        padding: 0 12px;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        line-height: 22px;
      }

      .session-status:empty { display: none; }

      .loading-dots {
        position: relative;
        display: inline-block;
        flex: 0 0 13px;
        width: 13px;
        height: 13px;
        color: var(--vscode-descriptionForeground);
        animation: loading-dots-spin 1s linear infinite;
      }

      .loading-dots > span {
        position: absolute;
        width: 3px;
        height: 3px;
        border-radius: 50%;
        background: currentColor;
      }

      .loading-dots > span:nth-child(1) { top: 0; left: 5px; opacity: 1; }
      .loading-dots > span:nth-child(2) { right: 1px; bottom: 1px; opacity: 0.65; }
      .loading-dots > span:nth-child(3) { bottom: 1px; left: 1px; opacity: 0.35; }

      .session-status-label[data-scanning="true"] {
        color: transparent;
        background: linear-gradient(
          100deg,
          var(--vscode-descriptionForeground) 0%,
          var(--vscode-descriptionForeground) 38%,
          var(--vscode-foreground) 50%,
          var(--vscode-descriptionForeground) 62%,
          var(--vscode-descriptionForeground) 100%
        );
        background-size: 250% 100%;
        background-clip: text;
        -webkit-background-clip: text;
        animation: loading-scan 1.8s linear infinite;
      }

      .session-elapsed { color: var(--vscode-descriptionForeground); }

      @keyframes loading-dots-spin { to { transform: rotate(360deg); } }

      @keyframes loading-scan {
        from { background-position: 100% 0; }
        to { background-position: -150% 0; }
      }

      @media (prefers-reduced-motion: reduce) {
        .loading-dots,
        .session-status-label[data-scanning="true"] { animation: none; }
      }

      .session-status[data-error="true"] {
        color: var(--vscode-errorForeground);
      }

      .workflow-surface {
        padding: 16px;
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }

      .composer-region {
        display: grid;
        gap: 4px;
        padding: 6px 10px 10px;
        background: var(--vscode-editor-background);
      }

      .composer-card {
        position: relative;
        display: grid;
        width: 100%;
        min-width: 0;
        min-height: 0;
        padding: 9px 10px 38px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-input-background);
        color: var(--vscode-input-foreground);
      }

      .composer {
        display: block;
        width: 100%;
        min-width: 0;
        height: 20px;
        min-height: 20px;
        max-height: 144px;
        padding: 0;
        border: 0;
        outline: 0;
        resize: none;
        color: var(--vscode-input-foreground);
        background: transparent;
        line-height: 20px;
        overflow-y: hidden;
      }

      .composer::placeholder {
        color: var(--vscode-input-placeholderForeground);
      }

      .composer-action {
        position: absolute;
        right: 10px;
        bottom: 6px;
        width: 28px;
        height: 28px;
        display: grid;
        padding: 0;
        place-items: center;
        border: 1px solid var(--vscode-button-background);
        border-radius: 3px;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
        cursor: pointer;
      }

      .composer-toolbar {
        position: absolute;
        right: 46px;
        bottom: 6px;
        left: 10px;
        display: flex;
        min-width: 0;
        height: 28px;
        align-items: center;
        gap: 4px;
      }

      .attachment-list {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-bottom: 10px;
      }

      .attachment-preview {
        position: relative;
        width: 88px;
        height: 88px;
        overflow: hidden;
        border: 1px solid var(--vscode-panel-border);
        border-radius: 8px;
        background: var(--vscode-editor-background);
      }

      .attachment-preview img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }

      .attachment-remove {
        position: absolute;
        top: 4px;
        right: 4px;
        display: grid;
        width: 20px;
        height: 20px;
        padding: 0;
        place-items: center;
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 50%;
        background: rgba(0, 0, 0, 0.72);
        color: white;
        line-height: 1;
        cursor: pointer;
      }

      .user-message-menu {
        position: absolute;
        z-index: 30;
        right: 12px;
        bottom: 42px;
        width: min(320px, calc(100% - 24px));
        max-height: 240px;
        overflow-y: auto;
        padding: 4px;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-menu-background, var(--vscode-dropdown-background));
        color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
        box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      }

      .user-message-option {
        display: block;
        width: 100%;
        padding: 6px 8px;
        overflow: hidden;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: inherit;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }

      .user-message-option:hover { background: var(--vscode-list-hoverBackground); }
      .user-message-empty { padding: 8px; color: var(--vscode-descriptionForeground); }

      .custom-select {
        position: relative;
        flex: 0 0 auto;
      }

      .custom-select[data-select-kind="model"] { width: 96px; }
      .custom-select[data-select-kind="effort"] { width: 92px; }

      .custom-select-trigger {
        display: flex;
        width: 100%;
        height: 28px;
        min-width: 0;
        align-items: center;
        gap: 8px;
        padding: 0 7px 0 8px;
        border: 1px solid var(--vscode-dropdown-border, var(--vscode-panel-border));
        border-radius: 3px;
        outline: 0;
        background: var(--vscode-dropdown-background);
        color: var(--vscode-dropdown-foreground);
        font-size: 11px;
        cursor: pointer;
      }

      .custom-select-trigger:hover { background: var(--vscode-list-hoverBackground); }
      .custom-select-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .custom-select-chevron { width: 10px; height: 10px; margin-left: auto; }

      .custom-select-menu {
        position: absolute;
        z-index: 20;
        bottom: 32px;
        left: 0;
        min-width: max(100%, 132px);
        margin: 0;
        padding: 3px;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-menu-background, var(--vscode-dropdown-background));
        color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
        box-shadow: 0 2px 8px var(--vscode-widget-shadow);
        list-style: none;
      }

      .custom-select-option {
        display: flex;
        width: 100%;
        min-height: 26px;
        align-items: center;
        padding: 4px 7px;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }

      .custom-select-option:hover,
      .custom-select-option[aria-selected="true"] {
        background: var(--vscode-list-activeSelectionBackground);
        color: var(--vscode-list-activeSelectionForeground);
      }

      .tool-button {
        display: grid;
        flex: 0 0 28px;
        width: 28px;
        height: 28px;
        padding: 0;
        place-items: center;
        border: 0;
        border-radius: 3px;
        background: transparent;
        color: var(--vscode-descriptionForeground);
        cursor: pointer;
      }

      .tool-button:hover { background: var(--vscode-toolbar-hoverBackground); }
      .tool-button[aria-pressed="true"] {
        background: var(--vscode-button-secondaryBackground);
        color: var(--vscode-button-secondaryForeground);
      }
      .tool-button svg, .session-close svg { width: 14px; height: 14px; }
      .composer-spacer { flex: 1 1 auto; }

      .status-strip {
        position: relative;
        display: flex;
        min-width: 0;
        height: 19px;
        align-items: center;
        gap: 4px;
        padding: 0 4px;
        border-top: 1px solid var(--vscode-panel-border);
        background: var(--vscode-statusBar-background, var(--vscode-editor-background));
        color: var(--vscode-statusBar-foreground, var(--vscode-descriptionForeground));
        font-size: 11px;
        white-space: nowrap;
      }

      .status-model {
        flex: 0 0 80px;
        width: 80px;
        overflow: hidden;
        color: var(--vscode-symbolIcon-numberForeground, #e5a44b);
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      [data-status-item="effort"] {
        flex: 0 0 44px;
        width: 44px;
        text-align: left;
      }

      [data-status-item="usage"] {
        flex: 0 0 110px;
        width: 110px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      [data-status-item="session"] {
        flex: 0 0 96px;
        width: 96px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      [data-status-item="ready"] {
        flex: 0 1 96px;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .status-context, .status-ready { color: var(--vscode-textLink-foreground); }
      .status-action {
        height: 18px;
        padding: 0 2px;
        border: 0;
        border-radius: 2px;
        background: transparent;
        cursor: pointer;
      }
      .status-action:hover { background: var(--vscode-statusBarItem-hoverBackground, var(--vscode-toolbar-hoverBackground)); }
      .status-meter {
        width: 52px;
        height: 3px;
        overflow: hidden;
        border-radius: 2px;
        background: var(--vscode-progressBar-background);
        opacity: 0.55;
      }
      .status-meter-fill { width: 0%; height: 100%; background: currentColor; }
      .status-settings {
        order: 1000;
        flex: 0 0 22px;
        width: 22px;
        height: 18px;
        margin-left: auto;
      }

      .status-settings-menu {
        position: absolute;
        z-index: 30;
        right: 6px;
        bottom: 24px;
        min-width: 150px;
        max-height: 320px;
        overflow-y: auto;
        padding: 4px;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        border-radius: 4px;
        background: var(--vscode-menu-background, var(--vscode-dropdown-background));
        color: var(--vscode-menu-foreground, var(--vscode-dropdown-foreground));
        box-shadow: 0 2px 8px var(--vscode-widget-shadow);
        scrollbar-width: none;
      }

      .status-settings-menu::-webkit-scrollbar { display: none; }

      .status-settings-option {
        display: flex;
        width: 100%;
        min-height: 26px;
        align-items: center;
        gap: 7px;
        padding: 3px 7px;
        border: 0;
        border-radius: 2px;
        background: transparent;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }

      .status-settings-option:hover { background: var(--vscode-list-hoverBackground); }
      .status-settings-option[draggable="true"] { cursor: grab; }
      .status-settings-option.is-dragging { opacity: 0.4; }
      .status-settings-option.is-drag-target {
        box-shadow: inset 0 2px var(--vscode-focusBorder);
      }
      .status-settings-check { width: 12px; }

      .composer-action:disabled {
        cursor: default;
        opacity: 0.45;
      }

      [hidden] { display: none !important; }
    </style>
  </head>
  <body>
    <main class="chat-shell">
      <nav class="mode-tabs" role="tablist" aria-label="Agent chat modes">
        <button class="mode-tab" type="button" role="tab" data-mode="main" aria-selected="true" tabindex="0">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M8 2.25 13 5v6L8 13.75 3 11V5l5-2.75Z"></path>
            <circle cx="8" cy="8" r="2"></circle>
          </svg>
          <span>Main Agent Sessions</span>
          <span class="mode-tab-indicator" aria-hidden="true"></span>
        </button>
        <button class="mode-tab" type="button" role="tab" data-mode="workflow" aria-selected="false" tabindex="-1">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="4" cy="4" r="1.75"></circle>
            <circle cx="12" cy="12" r="1.75"></circle>
            <circle cx="4" cy="12" r="1.75"></circle>
            <path d="m5.4 5.2 5.1 5.1M5.75 12h4.5"></path>
          </svg>
          <span>Workflow Session</span>
          <span class="mode-tab-indicator" aria-hidden="true"></span>
        </button>
      </nav>
      <header class="session-header">
        <nav class="session-tabs" role="tablist" aria-label="Local agent sessions" data-session-tabs></nav>
        <button class="new-session" type="button" aria-label="New local session" data-new-session>
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <path d="M3 2.5h7l3 3v8H3v-11Z"></path>
            <path d="M10 2.5v3h3M8 7v4M6 9h4"></path>
          </svg>
        </button>
        <button class="new-session session-menu" type="button" aria-label="Session menu" title="Session menu">
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10"></path></svg>
        </button>
      </header>
      <section class="mode-panel" role="tabpanel" data-mode-panel="main">
        <div class="messages" role="log" aria-live="polite" data-messages></div>
      </section>
      <section class="mode-panel workflow-surface" role="tabpanel" data-mode-panel="workflow" hidden>
        <p>Workflow 실행 연결은 이번 Work Unit 범위에 포함되지 않습니다.</p>
      </section>
      <footer class="composer-region">
        <div class="session-status" role="status" data-session-status hidden>
          <span class="loading-dots" aria-hidden="true" data-loading-dots>
            <span></span><span></span><span></span>
          </span>
          <span class="session-status-label" data-session-status-label></span>
          <span class="session-elapsed" data-session-elapsed></span>
        </div>
        <div class="composer-card">
          <div class="attachment-list" data-attachment-list hidden></div>
          <textarea
            class="composer"
            aria-label="Session draft"
            placeholder="메시지를 입력하세요..."
            data-composer
          ></textarea>
          <div class="composer-toolbar" aria-label="Composer options">
            <div class="custom-select" data-custom-select data-select-kind="model">
              <button class="custom-select-trigger" type="button" aria-label="Model" aria-haspopup="listbox" aria-expanded="false">
                <span class="custom-select-label">GPT-5.5</span>
                <svg class="custom-select-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"></path></svg>
              </button>
              <ul class="custom-select-menu" role="listbox" hidden>
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.6-sol" data-default-effort="low" data-efforts="low,medium,high,xhigh,max,ultra">GPT-5.6-Sol</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.6-terra" data-default-effort="medium" data-efforts="low,medium,high,xhigh,max,ultra">GPT-5.6-Terra</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.6-luna" data-default-effort="medium" data-efforts="low,medium,high,xhigh,max">GPT-5.6-Luna</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.5" data-default-effort="medium" data-efforts="low,medium,high,xhigh">GPT-5.5</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.4" data-default-effort="medium" data-efforts="low,medium,high,xhigh">GPT-5.4</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.4-mini" data-default-effort="medium" data-efforts="low,medium,high,xhigh">GPT-5.4-Mini</button></li>
              </ul>
            </div>
            <div class="custom-select" data-custom-select data-select-kind="effort">
              <button class="custom-select-trigger" type="button" aria-label="Reasoning effort" aria-haspopup="listbox" aria-expanded="false">
                <span class="custom-select-label">중간</span>
                <svg class="custom-select-chevron" viewBox="0 0 12 12" aria-hidden="true"><path d="m3 4.5 3 3 3-3"></path></svg>
              </button>
              <ul class="custom-select-menu" role="listbox" hidden>
                <li><button class="custom-select-option" type="button" role="option" data-value="low">낮음</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="medium">중간</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="high">높음</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="xhigh">매우 높음</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="max">최대</button></li>
                <li><button class="custom-select-option" type="button" role="option" data-value="ultra">울트라</button></li>
              </ul>
            </div>
            <button class="tool-button" type="button" title="Fast 모드 켜기" aria-label="Fast 모드" aria-pressed="false" data-fast-mode>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.25 1.5 3.5 9h3.75l-.5 5.5L12.5 7H8.75l.5-5.5Z"></path></svg>
            </button>
            <button class="tool-button" type="button" title="Goal 모드 켜기" aria-label="Goal 모드" aria-pressed="false" data-goal>
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="5.5"></circle><circle cx="8" cy="8" r="2.75"></circle><circle cx="8" cy="8" r=".7" fill="currentColor" stroke="none"></circle></svg>
            </button>
            <span class="composer-spacer"></span>
            <button class="tool-button" type="button" title="사용자 메시지 목록" aria-label="사용자 메시지 목록" aria-haspopup="menu" aria-expanded="false" data-user-messages>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 3.25h11v7.5h-6l-3.5 2.5v-2.5H2.5v-7.5Z"></path><path d="M5 6h6M5 8h4"></path></svg>
            </button>
          </div>
          <div class="user-message-menu" role="menu" aria-label="사용자 메시지 목록" data-user-message-menu hidden></div>
          <button class="composer-action" type="button" aria-label="Send message" data-send>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="M8 13.5v-10M4.5 7 8 3.5 11.5 7"></path>
            </svg>
          </button>
          <button class="composer-action" type="button" aria-label="Cancel response" data-cancel hidden>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="4" y="4" width="8" height="8" rx="1"></rect>
            </svg>
          </button>
        </div>
      </footer>
      <div class="status-strip" role="status" aria-label="Agent status">
        <button class="status-action status-model" type="button" data-status-item="model" data-status-model title="모델 선택">gpt-5.5</button>
        <button class="status-action" type="button" data-status-item="effort" data-status-effort title="추론 수준 선택">중간</button>
        <span data-status-item="fast">Fast off</span>
        <span data-status-item="goal">Goal off</span>
        <span class="status-context" data-status-item="usage" data-status-usage>Context 0 tokens</span>
        <span data-status-item="input">Input 0</span>
        <span data-status-item="cached">Cached 0</span>
        <span data-status-item="output">Output 0</span>
        <span data-status-item="total">Total 0</span>
        <span data-status-item="contextLeft">Context left —</span>
        <span data-status-item="weeklyLeft">Weekly left —</span>
        <span data-status-item="gitBranch">Branch —</span>
        <span data-status-item="session" data-status-session>Local session</span>
        <span data-status-item="thread">Thread —</span>
        <span data-status-item="cwd">CWD —</span>
        <span data-status-item="progress">Idle</span>
        <span data-status-item="elapsed">0s</span>
        <span data-status-item="started">Started —</span>
        <span data-status-item="completed">Completed —</span>
        <span class="status-ready" data-status-item="ready" data-status-ready>Ready</span>
        <button class="tool-button status-settings" type="button" title="표시할 상태 항목 선택" aria-label="표시할 상태 항목 선택" aria-haspopup="menu" aria-expanded="false" data-status-settings>
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5"></circle><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14"></path></svg>
        </button>
        <div class="status-settings-menu" role="menu" aria-label="상태 표시 항목" data-status-settings-menu hidden>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="model"><span class="status-settings-check"></span>모델</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="effort"><span class="status-settings-check"></span>추론 수준</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="fast"><span class="status-settings-check"></span>Fast 모드</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="goal"><span class="status-settings-check"></span>Goal 모드</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="usage"><span class="status-settings-check"></span>컨텍스트 토큰</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="input"><span class="status-settings-check"></span>입력 토큰</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="cached"><span class="status-settings-check"></span>캐시 토큰</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="output"><span class="status-settings-check"></span>출력 토큰</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="total"><span class="status-settings-check"></span>전체 토큰</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="contextLeft"><span class="status-settings-check"></span>Context left</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="weeklyLeft"><span class="status-settings-check"></span>Weekly left</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="gitBranch"><span class="status-settings-check"></span>Git branch</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="session"><span class="status-settings-check"></span>세션</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="thread"><span class="status-settings-check"></span>Codex Thread ID</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="cwd"><span class="status-settings-check"></span>작업 경로</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="progress"><span class="status-settings-check"></span>진행 단계</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="elapsed"><span class="status-settings-check"></span>경과 시간</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="started"><span class="status-settings-check"></span>시작 시각</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="completed"><span class="status-settings-check"></span>완료 시각</button>
          <button class="status-settings-option" type="button" role="menuitemcheckbox" data-status-toggle="ready"><span class="status-settings-check"></span>실행 상태</button>
        </div>
      </div>
    </main>
    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const groupMessagesIntoTurns = ${groupMessagesIntoTurns.toString()};
        const resizeComposerInput = ${resizeComposerInput.toString()};
        const shouldSubmitComposerKey = ${shouldSubmitComposerKey.toString()};
        const modeTabs = Array.from(document.querySelectorAll('[data-mode]'));
        const modePanels = Array.from(document.querySelectorAll('[data-mode-panel]'));
        const sessionTabs = document.querySelector('[data-session-tabs]');
        const newSession = document.querySelector('[data-new-session]');
        const composer = document.querySelector('[data-composer]');
        const sendButton = document.querySelector('[data-send]');
        const cancelButton = document.querySelector('[data-cancel]');
        const fastModeButton = document.querySelector('[data-fast-mode]');
        const goalButton = document.querySelector('[data-goal]');
        const userMessagesButton = document.querySelector('[data-user-messages]');
        const userMessageMenu = document.querySelector('[data-user-message-menu]');
        const attachmentList = document.querySelector('[data-attachment-list]');
        const messages = document.querySelector('[data-messages]');
        const status = document.querySelector('[data-session-status]');
        const statusLabelElement = document.querySelector('[data-session-status-label]');
        const statusElapsed = document.querySelector('[data-session-elapsed]');
        const loadingDots = document.querySelector('[data-loading-dots]');
        const customSelects = Array.from(document.querySelectorAll('[data-custom-select]'));
        const statusModel = document.querySelector('[data-status-model]');
        const statusEffort = document.querySelector('[data-status-effort]');
        const statusUsage = document.querySelector('[data-status-usage]');
        const statusSession = document.querySelector('[data-status-session]');
        const statusReady = document.querySelector('[data-status-ready]');
        const statusSettings = document.querySelector('[data-status-settings]');
        const statusSettingsMenu = document.querySelector('[data-status-settings-menu]');
        const statusItems = Array.from(document.querySelectorAll('[data-status-item]'));
        const statusToggles = Array.from(document.querySelectorAll('[data-status-toggle]'));
        const statusFields = Object.fromEntries(
          statusItems.map((item) => [item.dataset.statusItem, item]),
        );
        const storedState = vscode.getState() || {};
        const statusItemKeys = [
          "model", "effort", "fast", "goal", "usage", "input", "cached", "output",
          "total", "contextLeft", "weeklyLeft", "gitBranch", "session", "thread",
          "cwd", "progress", "elapsed", "started",
          "completed", "ready",
        ];
        const defaultVisibleStatusItems = new Set([
          "model", "effort", "usage", "session", "ready",
        ]);
        const storedStatusOrder = Array.isArray(storedState.statusOrder)
          ? storedState.statusOrder.filter((key) => statusItemKeys.includes(key))
          : [];
        const initialSession = {
          id: "local-1",
          title: "web",
          draft: "",
          model: "gpt-5.5",
          reasoningEffort: "medium",
          fastMode: false,
          goalMode: false,
        };
        const restoredSessions = Array.isArray(storedState.sessions) && storedState.sessions.length
          ? storedState.sessions.map((session) => ({
              ...session,
              model: typeof session.model === "string"
                ? session.model
                : (storedState.model || "gpt-5.5"),
              reasoningEffort: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(session.reasoningEffort)
                ? session.reasoningEffort
                : (storedState.reasoningEffort || "medium"),
              fastMode: session.fastMode === true,
              goalMode: session.goalMode === true,
            }))
          : [initialSession];
        const state = {
          activeMode: storedState.activeMode === "workflow" ? "workflow" : "main",
          sessions: restoredSessions,
          activeSessionId: storedState.activeSessionId || initialSession.id,
          nextSessionNumber: Number.isInteger(storedState.nextSessionNumber)
            ? storedState.nextSessionNumber
            : 2,
          backendSessions: storedState.backendSessions || {},
          backendRuntime: storedState.backendRuntime || {},
          pendingImages: {},
          statusVisibility: Object.fromEntries(statusItemKeys.map((key) => [
            key,
            typeof storedState.statusVisibility?.[key] === "boolean"
              ? storedState.statusVisibility[key]
              : defaultVisibleStatusItems.has(key),
          ])),
          statusOrder: [
            ...new Set([...storedStatusOrder, ...statusItemKeys]),
          ],
        };

        function activeSession() {
          return state.sessions.find((session) => session.id === state.activeSessionId)
            || state.sessions[0];
        }

        function backendSession() {
          return state.backendSessions[state.activeSessionId] || {
            messages: [],
            status: "idle",
            progress: null,
            error: null,
          };
        }

        function persist() {
          vscode.setState({
            activeMode: state.activeMode,
            sessions: state.sessions,
            activeSessionId: state.activeSessionId,
            nextSessionNumber: state.nextSessionNumber,
            backendSessions: state.backendSessions,
            backendRuntime: state.backendRuntime,
            statusVisibility: state.statusVisibility,
            statusOrder: state.statusOrder,
          });
        }

        function renderStatusVisibility() {
          for (const item of statusItems) {
            item.hidden = !state.statusVisibility[item.dataset.statusItem];
            item.style.order = String(state.statusOrder.indexOf(item.dataset.statusItem));
          }
          for (const key of state.statusOrder) {
            const toggle = statusToggles.find((item) => item.dataset.statusToggle === key);
            if (!toggle) continue;
            const checked = state.statusVisibility[toggle.dataset.statusToggle];
            toggle.setAttribute("aria-checked", String(checked));
            toggle.querySelector(".status-settings-check").textContent = checked ? "✓" : "";
            statusSettingsMenu.append(toggle);
          }
        }

        function closeStatusSettings() {
          statusSettingsMenu.hidden = true;
          statusSettings.setAttribute("aria-expanded", "false");
        }

        function createSvgIcon(pathData, viewBox = "0 0 16 16") {
          const namespace = "http://www.w3.org/2000/svg";
          const svg = document.createElementNS(namespace, "svg");
          svg.setAttribute("viewBox", viewBox);
          svg.setAttribute("aria-hidden", "true");
          svg.setAttribute("focusable", "false");
          for (const data of pathData) {
            const path = document.createElementNS(namespace, "path");
            path.setAttribute("d", data);
            svg.append(path);
          }
          return svg;
        }

        function activateMode(mode, options = {}) {
          if (!modeTabs.some((tab) => tab.dataset.mode === mode)) return;
          state.activeMode = mode;
          for (const tab of modeTabs) {
            const selected = tab.dataset.mode === mode;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && options.focus) tab.focus();
          }
          for (const panel of modePanels) {
            panel.hidden = panel.dataset.modePanel !== mode;
          }
          composer.closest("footer").hidden = mode !== "main";
          persist();
        }

        function renderSessions() {
          sessionTabs.replaceChildren();
          for (const session of state.sessions) {
            const tab = document.createElement("div");
            const selected = session.id === state.activeSessionId;
            tab.className = "session-tab";
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            const icon = createSvgIcon([
              "M2.5 3.5h8v8h-8z",
              "M5.5 6.5h5v5",
            ]);
            icon.classList.add("session-tab-icon");
            const label = document.createElement("span");
            label.className = "session-tab-label";
            label.textContent = session.title;
            const kind = document.createElement("span");
            kind.className = "session-kind";
            kind.textContent = "· EXEC";
            const close = document.createElement("button");
            close.className = "session-close";
            close.type = "button";
            close.title = "Close session";
            close.setAttribute("aria-label", "Close " + session.title);
            close.append(createSvgIcon([
              "m4.5 4.5 7 7",
              "m11.5 4.5-7 7",
            ]));
            close.addEventListener("click", (event) => {
              event.stopPropagation();
              if (state.sessions.length === 1) return;
              const backend = state.backendSessions[session.id];
              if (backend?.status === "running" || backend?.status === "cancelling") return;
              const index = state.sessions.findIndex((item) => item.id === session.id);
              state.sessions.splice(index, 1);
              delete state.backendSessions[session.id];
              vscode.postMessage({ type: "chat.session.delete", sessionId: session.id });
              if (selected) state.activeSessionId = state.sessions[Math.max(0, index - 1)].id;
              composer.value = activeSession().draft;
              syncSelectionControls();
              render();
              persist();
            });
            tab.append(icon, label, kind, close);
            tab.addEventListener("click", () => {
              state.activeSessionId = session.id;
              composer.value = activeSession().draft;
              resizeComposerInput(composer);
              render();
              persist();
            });
            tab.addEventListener("keydown", (event) => {
              if (event.key !== "Enter" && event.key !== " ") return;
              event.preventDefault();
              tab.click();
            });
            sessionTabs.append(tab);
          }
        }

        function renderMessages() {
          messages.replaceChildren();
          const session = backendSession();
          if (!session.messages.length) {
            const empty = document.createElement("p");
            empty.className = "empty-state";
            empty.textContent = "이 세션에서 Codex와 대화를 시작하세요.";
            messages.append(empty);
          } else {
            for (const items of groupMessagesIntoTurns(session.messages)) {
              const turn = document.createElement("section");
              turn.className = "message-turn";
              for (const item of items) {
                const element = document.createElement("article");
                element.className = "message message-" + item.role;
                element.dataset.role = item.role;
                element.dataset.messageIndex = String(session.messages.indexOf(item));
                element.textContent = item.text;
                turn.append(element);
              }
              messages.append(turn);
            }
          }
          const running = session.status === "running" || session.status === "cancelling";
          sendButton.disabled = running
            || (!composer.value.trim() && !state.pendingImages[activeSession().id]?.length);
          sendButton.hidden = running;
          cancelButton.hidden = !running;
          renderSessionStatus(session);
          renderStatusLine(session);
          messages.scrollTop = messages.scrollHeight;
        }

        function renderSessionStatus(session) {
          const running = session.status === "running" || session.status === "cancelling";
          const label = session.error
            || (running && session.progress)
            || statusLabel(session.status);
          status.hidden = !label;
          status.dataset.error = String(Boolean(session.error));
          loadingDots.hidden = !running;
          statusLabelElement.dataset.scanning = String(running);
          statusLabelElement.textContent = label || "";
          if (running && session.startedAt) {
            const seconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
            statusElapsed.textContent = "· " + seconds + "s";
          } else {
            statusElapsed.textContent = "";
          }
        }

        function renderStatusLine(session) {
          const localSession = activeSession();
          const effortLabels = {
            low: "낮음",
            medium: "중간",
            high: "높음",
            xhigh: "매우 높음",
            max: "최대",
            ultra: "울트라",
          };
          statusModel.textContent = localSession.model;
          statusEffort.textContent = effortLabels[localSession.reasoningEffort];
          const usage = session.usage || {};
          const inputTokens = Number(usage.input_tokens) || 0;
          const cachedTokens = Number(usage.cached_input_tokens) || 0;
          const outputTokens = Number(usage.output_tokens) || 0;
          const totalTokens = Number(usage.total_tokens) || inputTokens + outputTokens;
          statusUsage.textContent = "Context " + inputTokens.toLocaleString() + " tokens";
          statusUsage.title = "입력 " + inputTokens.toLocaleString()
            + " · 캐시 " + cachedTokens.toLocaleString()
            + " · 출력 " + outputTokens.toLocaleString();
          statusFields.fast.textContent = localSession.fastMode ? "Fast on" : "Fast off";
          statusFields.goal.textContent = localSession.goalMode ? "Goal on" : "Goal off";
          statusFields.input.textContent = "Input " + inputTokens.toLocaleString();
          statusFields.cached.textContent = "Cached " + cachedTokens.toLocaleString();
          statusFields.output.textContent = "Output " + outputTokens.toLocaleString();
          statusFields.total.textContent = "Total " + totalTokens.toLocaleString();
          const contextWindow = 272000;
          const contextRemaining = Math.max(0, contextWindow - inputTokens);
          const contextRemainingPercent = Math.round((contextRemaining / contextWindow) * 100);
          statusFields.contextLeft.textContent = "Context left "
            + contextRemainingPercent + "%";
          statusFields.contextLeft.title = contextRemaining.toLocaleString()
            + " / " + contextWindow.toLocaleString() + " tokens";
          const runtime = state.backendRuntime || {};
          statusFields.weeklyLeft.textContent = Number.isFinite(runtime.weeklyRemainingPercent)
            ? "Weekly left " + Math.round(runtime.weeklyRemainingPercent) + "%"
            : "Weekly left —";
          statusFields.weeklyLeft.title = runtime.weeklyResetsAt
            ? "Reset " + new Date(runtime.weeklyResetsAt * 1000).toLocaleString()
            : "";
          statusFields.gitBranch.textContent = runtime.gitBranch
            ? "Branch " + runtime.gitBranch
            : "Branch —";
          statusFields.gitBranch.title = runtime.gitBranch || "";
          statusSession.textContent = session.providerSessionId ? "Resumable session" : "Local session";
          const threadId = session.providerSessionId || "";
          statusFields.thread.textContent = threadId
            ? "Thread " + threadId.slice(0, 8)
            : "Thread —";
          statusFields.thread.title = threadId;
          const cwd = session.cwd || "";
          statusFields.cwd.textContent = cwd
            ? "CWD " + (cwd.split(/[\\/]/).pop() || cwd)
            : "CWD —";
          statusFields.cwd.title = cwd;
          statusFields.progress.textContent = session.progress || session.status || "Idle";
          const endTime = session.completedAt || Date.now();
          const elapsedSeconds = session.startedAt
            ? Math.max(0, Math.floor((endTime - session.startedAt) / 1000))
            : 0;
          statusFields.elapsed.textContent = elapsedSeconds + "s";
          statusFields.started.textContent = session.startedAt
            ? "Started " + new Date(session.startedAt).toLocaleTimeString()
            : "Started —";
          statusFields.completed.textContent = session.completedAt
            ? "Completed " + new Date(session.completedAt).toLocaleTimeString()
            : "Completed —";
          if (session.error) {
            statusReady.textContent = "Error";
          } else if (session.status === "running") {
            statusReady.textContent = session.progress || "Running";
          } else if (session.status === "cancelling") {
            statusReady.textContent = "Cancelling";
          } else {
            statusReady.textContent = "Ready";
          }
        }

        function statusLabel(value) {
          if (value === "running") return "Codex가 응답하고 있습니다…";
          if (value === "cancelling") return "응답을 취소하고 있습니다…";
          if (value === "cancelled") return "응답이 취소되었습니다.";
          if (value === "interrupted") return "이전 실행이 중단되었습니다.";
          return "";
        }

        function render() {
          fastModeButton.setAttribute("aria-pressed", String(activeSession().fastMode));
          fastModeButton.title = activeSession().fastMode ? "Fast 모드 끄기" : "Fast 모드 켜기";
          goalButton.setAttribute("aria-pressed", String(activeSession().goalMode));
          goalButton.title = activeSession().goalMode ? "Goal 모드 끄기" : "Goal 모드 켜기";
          syncSelectionControls();
          renderSessions();
          renderMessages();
          renderAttachments();
        }

        function submit() {
          const prompt = composer.value.trim();
          const hasImages = Boolean(state.pendingImages[activeSession().id]?.length);
          if ((!prompt && !hasImages) || sendButton.disabled) return;
          const session = activeSession();
          vscode.postMessage({
            type: "chat.submit",
            sessionId: session.id,
            prompt,
            model: session.model,
            reasoningEffort: session.reasoningEffort,
            fastMode: session.fastMode,
            goal: session.goalMode,
          });
          session.draft = "";
          delete state.pendingImages[session.id];
          renderAttachments();
          composer.value = "";
          resizeComposerInput(composer);
          persist();
          renderMessages();
        }

        function renderAttachments() {
          const images = state.pendingImages[activeSession().id] || [];
          attachmentList.replaceChildren();
          attachmentList.hidden = images.length === 0;
          images.forEach((image, index) => {
            const preview = document.createElement("div");
            preview.className = "attachment-preview";
            const thumbnail = document.createElement("img");
            thumbnail.src = image.preview;
            thumbnail.alt = image.name;
            thumbnail.title = image.name;
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "attachment-remove";
            remove.setAttribute("aria-label", image.name + " 제거");
            remove.textContent = "×";
            remove.addEventListener("click", () => {
              state.pendingImages[activeSession().id].splice(index, 1);
              vscode.postMessage({
                type: "chat.image.remove",
                sessionId: activeSession().id,
                index,
              });
              renderAttachments();
              sendButton.disabled = !composer.value.trim()
                && !state.pendingImages[activeSession().id]?.length;
            });
            preview.append(thumbnail, remove);
            attachmentList.append(preview);
          });
        }

        function closeCustomSelects(except) {
          for (const select of customSelects) {
            if (select === except) continue;
            select.querySelector('.custom-select-trigger').setAttribute('aria-expanded', 'false');
            select.querySelector('.custom-select-menu').hidden = true;
          }
        }

        function syncSelectionControls() {
          const modelSelect = customSelects.find((select) => select.dataset.selectKind === 'model');
          const effortSelect = customSelects.find((select) => select.dataset.selectKind === 'effort');
          const session = activeSession();
          const modelOptions = Array.from(modelSelect.querySelectorAll('.custom-select-option'));
          const selectedModel = modelOptions.find((option) => option.dataset.value === session.model)
            || modelOptions.find((option) => option.dataset.value === 'gpt-5.5');
          session.model = selectedModel.dataset.value;
          const supportedEfforts = selectedModel.dataset.efforts.split(',');
          if (!supportedEfforts.includes(session.reasoningEffort)) {
            session.reasoningEffort = selectedModel.dataset.defaultEffort;
          }
          for (const option of modelOptions) {
            option.setAttribute('aria-selected', String(option === selectedModel));
          }
          modelSelect.querySelector('.custom-select-label').textContent = selectedModel.textContent;

          const effortOptions = Array.from(effortSelect.querySelectorAll('.custom-select-option'));
          const selectedEffort = effortOptions.find((option) => option.dataset.value === session.reasoningEffort);
          for (const option of effortOptions) {
            const supported = supportedEfforts.includes(option.dataset.value);
            option.closest('li').hidden = !supported;
            option.setAttribute('aria-selected', String(option === selectedEffort));
          }
          effortSelect.querySelector('.custom-select-label').textContent = selectedEffort.textContent;
        }

        for (const select of customSelects) {
          const kind = select.dataset.selectKind;
          const trigger = select.querySelector('.custom-select-trigger');
          const label = select.querySelector('.custom-select-label');
          const menu = select.querySelector('.custom-select-menu');
          const options = Array.from(select.querySelectorAll('.custom-select-option'));
          trigger.addEventListener('click', (event) => {
            event.stopPropagation();
            const opening = menu.hidden;
            closeCustomSelects(select);
            menu.hidden = !opening;
            trigger.setAttribute('aria-expanded', String(opening));
            if (opening) options.find((option) => option.getAttribute('aria-selected') === 'true')?.focus();
          });
          for (const option of options) {
            option.addEventListener('click', () => {
              if (kind === 'model') {
                activeSession().model = option.dataset.value;
              } else {
                activeSession().reasoningEffort = option.dataset.value;
              }
              syncSelectionControls();
              menu.hidden = true;
              trigger.setAttribute('aria-expanded', 'false');
              trigger.focus();
              renderStatusLine(backendSession());
              persist();
            });
          }
        }
        statusSettings.addEventListener("click", (event) => {
          event.stopPropagation();
          const opening = statusSettingsMenu.hidden;
          closeCustomSelects();
          statusSettingsMenu.hidden = !opening;
          statusSettings.setAttribute("aria-expanded", String(opening));
          if (opening) statusToggles[0]?.focus();
        });
        let draggedStatusKey = null;
        let suppressStatusToggleClick = false;
        for (const toggle of statusToggles) {
          toggle.draggable = true;
          toggle.addEventListener("click", (event) => {
            event.stopPropagation();
            if (suppressStatusToggleClick) return;
            const key = toggle.dataset.statusToggle;
            state.statusVisibility[key] = !state.statusVisibility[key];
            renderStatusVisibility();
            persist();
          });
          toggle.addEventListener("dragstart", (event) => {
            draggedStatusKey = toggle.dataset.statusToggle;
            suppressStatusToggleClick = true;
            toggle.classList.add("is-dragging");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", draggedStatusKey);
          });
          toggle.addEventListener("dragover", (event) => {
            if (!draggedStatusKey || draggedStatusKey === toggle.dataset.statusToggle) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
            for (const item of statusToggles) item.classList.remove("is-drag-target");
            toggle.classList.add("is-drag-target");
          });
          toggle.addEventListener("drop", (event) => {
            event.preventDefault();
            const targetKey = toggle.dataset.statusToggle;
            if (!draggedStatusKey || draggedStatusKey === targetKey) return;
            state.statusOrder = state.statusOrder.filter((key) => key !== draggedStatusKey);
            const targetIndex = state.statusOrder.indexOf(targetKey);
            state.statusOrder.splice(targetIndex, 0, draggedStatusKey);
            renderStatusVisibility();
            persist();
          });
          toggle.addEventListener("dragend", () => {
            draggedStatusKey = null;
            for (const item of statusToggles) {
              item.classList.remove("is-dragging", "is-drag-target");
            }
            window.setTimeout(() => {
              suppressStatusToggleClick = false;
            }, 0);
          });
        }
        document.addEventListener('click', () => {
          closeCustomSelects();
          closeStatusSettings();
          userMessageMenu.hidden = true;
          userMessagesButton.setAttribute("aria-expanded", "false");
        });
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') {
            closeCustomSelects();
            closeStatusSettings();
            userMessageMenu.hidden = true;
            userMessagesButton.setAttribute("aria-expanded", "false");
          }
        });
        statusModel.addEventListener('click', () => {
          customSelects.find((select) => select.dataset.selectKind === 'model')
            .querySelector('.custom-select-trigger').click();
        });
        statusEffort.addEventListener('click', () => {
          customSelects.find((select) => select.dataset.selectKind === 'effort')
            .querySelector('.custom-select-trigger').click();
        });

        for (const [index, tab] of modeTabs.entries()) {
          tab.addEventListener("click", () => activateMode(tab.dataset.mode));
          tab.addEventListener("keydown", (event) => {
            let targetIndex;
            if (event.key === "ArrowLeft") {
              targetIndex = (index - 1 + modeTabs.length) % modeTabs.length;
            } else if (event.key === "ArrowRight") {
              targetIndex = (index + 1) % modeTabs.length;
            } else if (event.key === "Home") {
              targetIndex = 0;
            } else if (event.key === "End") {
              targetIndex = modeTabs.length - 1;
            } else {
              return;
            }
            event.preventDefault();
            activateMode(modeTabs[targetIndex].dataset.mode, { focus: true });
          });
        }

        newSession.addEventListener("click", () => {
          const number = state.nextSessionNumber;
              const session = {
                id: "local-" + number,
                title: "web " + number,
                draft: "",
                model: activeSession().model,
                reasoningEffort: activeSession().reasoningEffort,
                fastMode: activeSession().fastMode,
                goalMode: false,
              };
          state.nextSessionNumber += 1;
          state.sessions.push(session);
          state.activeSessionId = session.id;
          composer.value = "";
          resizeComposerInput(composer);
          render();
          composer.focus();
          persist();
        });

        composer.addEventListener("input", () => {
          resizeComposerInput(composer);
          activeSession().draft = composer.value;
          sendButton.disabled =
            (!composer.value.trim() && !state.pendingImages[activeSession().id]?.length) ||
            ["running", "cancelling"].includes(backendSession().status);
          persist();
        });
        composer.addEventListener("keydown", (event) => {
          if (!shouldSubmitComposerKey(event)) return;
          event.preventDefault();
          submit();
        });
        sendButton.addEventListener("click", submit);
        goalButton.addEventListener("click", () => {
          const session = activeSession();
          session.goalMode = !session.goalMode;
          goalButton.setAttribute("aria-pressed", String(session.goalMode));
          goalButton.title = session.goalMode ? "Goal 모드 끄기" : "Goal 모드 켜기";
          persist();
        });
        fastModeButton.addEventListener("click", () => {
          const session = activeSession();
          session.fastMode = !session.fastMode;
          fastModeButton.setAttribute("aria-pressed", String(session.fastMode));
          fastModeButton.title = session.fastMode ? "Fast 모드 끄기" : "Fast 모드 켜기";
          persist();
        });
        userMessagesButton.addEventListener("click", (event) => {
          event.stopPropagation();
          const opening = userMessageMenu.hidden;
          userMessageMenu.replaceChildren();
          if (opening) {
            const session = backendSession();
            const userMessages = session.messages
              .map((message, index) => ({ message, index }))
              .filter(({ message }) => message.role === "user");
            if (!userMessages.length) {
              const empty = document.createElement("div");
              empty.className = "user-message-empty";
              empty.textContent = "사용자 메시지가 없습니다.";
              userMessageMenu.append(empty);
            }
            for (const { message, index } of userMessages) {
              const option = document.createElement("button");
              option.type = "button";
              option.className = "user-message-option";
              option.setAttribute("role", "menuitem");
              option.textContent = message.text.replace(/\s+/g, " ").trim();
              option.title = option.textContent;
              option.addEventListener("click", () => {
                userMessageMenu.hidden = true;
                userMessagesButton.setAttribute("aria-expanded", "false");
                messages.querySelector('[data-message-index="' + index + '"]')
                  ?.scrollIntoView({ behavior: "smooth", block: "center" });
              });
              userMessageMenu.append(option);
            }
          }
          userMessageMenu.hidden = !opening;
          userMessagesButton.setAttribute("aria-expanded", String(opening));
        });
        composer.addEventListener("paste", async (event) => {
          const files = Array.from(event.clipboardData?.files || [])
            .filter((file) => file.type.startsWith("image/"));
          if (!files.length) return;
          event.preventDefault();
          const images = [];
          for (const file of files) {
            if (file.size > 20 * 1024 * 1024) continue;
            images.push({
              name: file.name,
              type: file.type,
              data: Array.from(new Uint8Array(await file.arrayBuffer())),
            });
          }
          if (!images.length) return;
          vscode.postMessage({
            type: "chat.image.paste",
            sessionId: activeSession().id,
            images,
          });
        });
        cancelButton.addEventListener("click", () => {
          vscode.postMessage({
            type: "chat.cancel",
            sessionId: activeSession().id,
          });
        });
        window.addEventListener("message", (event) => {
          const message = event.data;
          if (message?.type === "chat.images.selected") {
            state.pendingImages[message.sessionId] = message.append
              ? [...(state.pendingImages[message.sessionId] || []), ...message.images]
              : message.images;
            if (message.sessionId === activeSession().id) {
              renderAttachments();
              sendButton.disabled = false;
            }
            return;
          }
          if (!message || message.type !== "chat.snapshot") return;
          const snapshot = message.snapshot;
          if (!snapshot || snapshot.version !== 1 || !snapshot.sessions) return;
          state.backendSessions = snapshot.sessions;
          state.backendRuntime = snapshot.runtime || {};
          renderMessages();
          persist();
        });
        window.setInterval(() => {
          const session = backendSession();
          if (session.status === "running" || session.status === "cancelling") {
            renderSessionStatus(session);
            renderStatusLine(session);
          }
        }, 1000);

        composer.value = activeSession().draft;
        renderAttachments();
        renderStatusVisibility();
        syncSelectionControls();
        resizeComposerInput(composer);
        render();
        activateMode(state.activeMode);
        vscode.postMessage({ type: "chat.ready" });
      })();
    </script>
  </body>
</html>`;
}

module.exports = {
  configureChatWebview,
  createChatViewHtml,
  groupMessagesIntoTurns,
  resizeComposerInput,
  shouldSubmitComposerKey,
};
