"use strict";

const { randomBytes } = require("node:crypto");

function configureChatWebview({
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
  const messageSubscription = webview.onDidReceiveMessage((message) =>
    controller.handleMessage(message),
  );

  return {
    dispose() {
      messageSubscription.dispose();
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
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
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
        gap: 6px;
        padding: 0 12px;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        line-height: 22px;
      }

      .session-status:empty { display: none; }

      .loading-spinner {
        width: 13px;
        height: 13px;
        animation: loading-spin 0.85s linear infinite;
      }

      .loading-spinner-track { opacity: 0.25; }
      .loading-spinner-head { stroke: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); }
      .session-elapsed { color: var(--vscode-descriptionForeground); }

      @keyframes loading-spin { to { transform: rotate(360deg); } }

      @media (prefers-reduced-motion: reduce) {
        .loading-spinner { animation-duration: 1.8s; }
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
        padding: 8px 10px 6px;
        border-top: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
      }

      .composer-card {
        position: relative;
        display: grid;
        width: 100%;
        min-width: 0;
        min-height: 88px;
        padding: 12px 12px 40px;
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
        right: 12px;
        bottom: 10px;
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
        right: 48px;
        bottom: 10px;
        left: 12px;
        display: flex;
        min-width: 0;
        height: 28px;
        align-items: center;
        gap: 4px;
      }

      .custom-select {
        position: relative;
        flex: 0 0 auto;
      }

      .custom-select-trigger {
        display: flex;
        height: 28px;
        min-width: 76px;
        max-width: 132px;
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
      .tool-button svg, .session-close svg { width: 14px; height: 14px; }
      .composer-spacer { flex: 1 1 auto; }

      .status-strip {
        display: flex;
        min-width: 0;
        height: 22px;
        align-items: center;
        gap: 7px;
        padding: 0 8px;
        border-top: 1px solid var(--vscode-panel-border);
        background: var(--vscode-statusBar-background, var(--vscode-editor-background));
        color: var(--vscode-statusBar-foreground, var(--vscode-descriptionForeground));
        font-size: 11px;
        white-space: nowrap;
      }

      .status-model { color: var(--vscode-symbolIcon-numberForeground, #e5a44b); }
      .status-context, .status-ready { color: var(--vscode-textLink-foreground); }
      .status-action {
        height: 20px;
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
      .status-settings { margin-left: auto; }

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
          <svg class="loading-spinner" viewBox="0 0 16 16" aria-hidden="true" data-loading-spinner>
            <circle class="loading-spinner-track" cx="8" cy="8" r="5.5"></circle>
            <path class="loading-spinner-head" d="M8 2.5a5.5 5.5 0 0 1 5.5 5.5"></path>
          </svg>
          <span data-session-status-label></span>
          <span class="session-elapsed" data-session-elapsed></span>
        </div>
        <div class="composer-card">
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
                <li><button class="custom-select-option" type="button" role="option" data-value="gpt-5.3-codex-spark" data-default-effort="high" data-efforts="low,medium,high,xhigh">GPT-5.3-Codex-Spark</button></li>
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
            <button class="tool-button" type="button" title="Quick action" aria-label="Quick action">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m9 1.75-5 7h3l-1 5.5 5-7H8l1-5.5Z"></path></svg>
            </button>
            <button class="tool-button" type="button" title="Context options" aria-label="Context options">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 3h6M8 3v8M5.5 8.5 8 11l2.5-2.5"></path></svg>
            </button>
            <button class="tool-button" type="button" title="Session settings" aria-label="Session settings">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3"></circle><path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2"></path></svg>
            </button>
            <span class="composer-spacer"></span>
            <button class="tool-button" type="button" title="Account" aria-label="Account">
              <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="5.25" r="2.25"></circle><path d="M3.75 13c.25-2.25 1.7-3.5 4.25-3.5s4 1.25 4.25 3.5"></path></svg>
            </button>
          </div>
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
        <button class="status-action status-model" type="button" data-status-model title="모델 선택">gpt-5.5</button>
        <button class="status-action" type="button" data-status-effort title="추론 수준 선택">중간</button>
        <span class="status-context" data-status-usage>Context 0 tokens</span>
        <span data-status-session>Local session</span>
        <span class="status-ready" data-status-ready>Ready</span>
        <button class="tool-button status-settings" type="button" title="Settings" aria-label="Settings">
          <svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.5"></circle><path d="M8 2v1.5M8 12.5V14M2 8h1.5M12.5 8H14"></path></svg>
        </button>
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
        const messages = document.querySelector('[data-messages]');
        const status = document.querySelector('[data-session-status]');
        const statusLabelElement = document.querySelector('[data-session-status-label]');
        const statusElapsed = document.querySelector('[data-session-elapsed]');
        const loadingSpinner = document.querySelector('[data-loading-spinner]');
        const customSelects = Array.from(document.querySelectorAll('[data-custom-select]'));
        const statusModel = document.querySelector('[data-status-model]');
        const statusEffort = document.querySelector('[data-status-effort]');
        const statusUsage = document.querySelector('[data-status-usage]');
        const statusSession = document.querySelector('[data-status-session]');
        const statusReady = document.querySelector('[data-status-ready]');
        const storedState = vscode.getState() || {};
        const initialSession = { id: "local-1", title: "web", draft: "" };
        const state = {
          activeMode: storedState.activeMode === "workflow" ? "workflow" : "main",
          sessions: Array.isArray(storedState.sessions) && storedState.sessions.length
            ? storedState.sessions
            : [initialSession],
          activeSessionId: storedState.activeSessionId || initialSession.id,
          nextSessionNumber: Number.isInteger(storedState.nextSessionNumber)
            ? storedState.nextSessionNumber
            : 2,
          backendSessions: storedState.backendSessions || {},
          model: typeof storedState.model === "string" ? storedState.model : "gpt-5.5",
          reasoningEffort: ["low", "medium", "high", "xhigh", "max", "ultra"].includes(storedState.reasoningEffort)
            ? storedState.reasoningEffort
            : "medium",
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
            model: state.model,
            reasoningEffort: state.reasoningEffort,
          });
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
              const index = state.sessions.findIndex((item) => item.id === session.id);
              state.sessions.splice(index, 1);
              if (selected) state.activeSessionId = state.sessions[Math.max(0, index - 1)].id;
              composer.value = activeSession().draft;
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
                element.textContent = item.text;
                turn.append(element);
              }
              messages.append(turn);
            }
          }
          const running = session.status === "running" || session.status === "cancelling";
          sendButton.disabled = running || !composer.value.trim();
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
          loadingSpinner.hidden = !running;
          statusLabelElement.textContent = label || "";
          if (running && session.startedAt) {
            const seconds = Math.max(0, Math.floor((Date.now() - session.startedAt) / 1000));
            statusElapsed.textContent = "· " + seconds + "s";
          } else {
            statusElapsed.textContent = "";
          }
        }

        function renderStatusLine(session) {
          const effortLabels = {
            low: "낮음",
            medium: "중간",
            high: "높음",
            xhigh: "매우 높음",
            max: "최대",
            ultra: "울트라",
          };
          statusModel.textContent = state.model;
          statusEffort.textContent = effortLabels[state.reasoningEffort];
          const usage = session.usage || {};
          const inputTokens = Number(usage.input_tokens) || 0;
          const cachedTokens = Number(usage.cached_input_tokens) || 0;
          const outputTokens = Number(usage.output_tokens) || 0;
          statusUsage.textContent = "Context " + inputTokens.toLocaleString() + " tokens";
          statusUsage.title = "입력 " + inputTokens.toLocaleString()
            + " · 캐시 " + cachedTokens.toLocaleString()
            + " · 출력 " + outputTokens.toLocaleString();
          statusSession.textContent = session.providerSessionId ? "Resumable session" : "Local session";
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
          renderSessions();
          renderMessages();
        }

        function submit() {
          const prompt = composer.value.trim();
          if (!prompt || sendButton.disabled) return;
          const session = activeSession();
          vscode.postMessage({
            type: "chat.submit",
            sessionId: session.id,
            prompt,
            model: state.model,
            reasoningEffort: state.reasoningEffort,
          });
          session.draft = "";
          composer.value = "";
          resizeComposerInput(composer);
          persist();
          renderMessages();
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
          const modelOptions = Array.from(modelSelect.querySelectorAll('.custom-select-option'));
          const selectedModel = modelOptions.find((option) => option.dataset.value === state.model)
            || modelOptions.find((option) => option.dataset.value === 'gpt-5.5');
          state.model = selectedModel.dataset.value;
          const supportedEfforts = selectedModel.dataset.efforts.split(',');
          if (!supportedEfforts.includes(state.reasoningEffort)) {
            state.reasoningEffort = selectedModel.dataset.defaultEffort;
          }
          for (const option of modelOptions) {
            option.setAttribute('aria-selected', String(option === selectedModel));
          }
          modelSelect.querySelector('.custom-select-label').textContent = selectedModel.textContent;

          const effortOptions = Array.from(effortSelect.querySelectorAll('.custom-select-option'));
          const selectedEffort = effortOptions.find((option) => option.dataset.value === state.reasoningEffort);
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
                state.model = option.dataset.value;
              } else {
                state.reasoningEffort = option.dataset.value;
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
        document.addEventListener('click', () => closeCustomSelects());
        document.addEventListener('keydown', (event) => {
          if (event.key === 'Escape') closeCustomSelects();
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
            !composer.value.trim() ||
            ["running", "cancelling"].includes(backendSession().status);
          persist();
        });
        composer.addEventListener("keydown", (event) => {
          if (!shouldSubmitComposerKey(event)) return;
          event.preventDefault();
          submit();
        });
        sendButton.addEventListener("click", submit);
        cancelButton.addEventListener("click", () => {
          vscode.postMessage({
            type: "chat.cancel",
            sessionId: activeSession().id,
          });
        });
        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || message.type !== "chat.snapshot") return;
          const snapshot = message.snapshot;
          if (!snapshot || snapshot.version !== 1 || !snapshot.sessions) return;
          state.backendSessions = snapshot.sessions;
          renderMessages();
          persist();
        });
        window.setInterval(() => {
          const session = backendSession();
          if (session.status === "running" || session.status === "cancelling") {
            renderSessionStatus(session);
          }
        }, 1000);

        composer.value = activeSession().draft;
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
