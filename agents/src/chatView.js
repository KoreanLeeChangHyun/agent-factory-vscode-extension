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

      button, textarea { font: inherit; }
      button { color: inherit; }

      .chat-shell {
        display: grid;
        grid-template-rows: auto auto minmax(0, 1fr) auto;
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
        flex: 0 0 auto;
        min-width: 88px;
        max-width: 160px;
        padding: 0 8px;
        overflow: hidden;
        border: 0;
        border-right: 1px solid var(--vscode-panel-border);
        background: var(--vscode-tab-inactiveBackground);
        color: var(--vscode-tab-inactiveForeground);
        cursor: pointer;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .session-tab[aria-selected="true"] {
        background: var(--vscode-tab-activeBackground);
        color: var(--vscode-tab-activeForeground);
      }

      .new-session {
        display: grid;
        flex: 0 0 44px;
        width: 44px;
        padding: 0;
        place-items: center;
        border: 0;
        background: transparent;
        cursor: pointer;
      }

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
        height: 22px;
        padding: 0 12px;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 0.9em;
        line-height: 22px;
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
        padding: 8px 0 0;
        border-top: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
      }

      .composer-card {
        position: relative;
        display: grid;
        width: 100%;
        min-width: 0;
        min-height: 72px;
        padding: 12px;
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
        padding: 0 44px 0 0;
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
        bottom: 12px;
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
      </header>
      <section class="mode-panel" role="tabpanel" data-mode-panel="main">
        <div class="messages" role="log" aria-live="polite" data-messages></div>
      </section>
      <section class="mode-panel workflow-surface" role="tabpanel" data-mode-panel="workflow" hidden>
        <p>Workflow 실행 연결은 이번 Work Unit 범위에 포함되지 않습니다.</p>
      </section>
      <footer class="composer-region">
        <div class="composer-card">
          <textarea
            class="composer"
            aria-label="Session draft"
            placeholder="Codex에 메시지를 보내세요..."
            data-composer
          ></textarea>
          <button class="composer-action" type="button" aria-label="Send message" data-send>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m2.5 3 11 5-11 5 2-5-2-5Z"></path>
              <path d="M4.5 8h5"></path>
            </svg>
          </button>
          <button class="composer-action" type="button" aria-label="Cancel response" data-cancel hidden>
            <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <rect x="4" y="4" width="8" height="8" rx="1"></rect>
            </svg>
          </button>
        </div>
        <div class="session-status" role="status" data-session-status></div>
      </footer>
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
        const storedState = vscode.getState() || {};
        const initialSession = { id: "local-1", title: "Session 1", draft: "" };
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
          });
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
            const tab = document.createElement("button");
            const selected = session.id === state.activeSessionId;
            tab.className = "session-tab";
            tab.type = "button";
            tab.setAttribute("role", "tab");
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            tab.textContent = session.title;
            tab.addEventListener("click", () => {
              state.activeSessionId = session.id;
              composer.value = activeSession().draft;
              resizeComposerInput(composer);
              render();
              persist();
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
          status.dataset.error = String(Boolean(session.error));
          status.textContent =
            session.error ||
            (running && session.progress) ||
            statusLabel(session.status);
          messages.scrollTop = messages.scrollHeight;
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
          });
          session.draft = "";
          composer.value = "";
          resizeComposerInput(composer);
          persist();
          renderMessages();
        }

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
            title: "Session " + number,
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

        composer.value = activeSession().draft;
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
