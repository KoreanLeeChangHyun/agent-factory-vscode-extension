"use strict";

const { randomBytes } = require("node:crypto");

const CHAT_VIEW_ID = "agentFactoryAgents.chat";

class AgentsChatViewProvider {
  resolveWebviewView(webviewView) {
    const { webview } = webviewView;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webview.html = createChatViewHtml({
      cspSource: webview.cspSource,
      nonce: randomBytes(18).toString("base64url"),
    });
  }
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
        background: var(--vscode-sideBar-background);
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-width: 220px;
        min-height: 100vh;
        margin: 0;
        overflow: hidden;
        background: var(--vscode-sideBar-background);
      }

      button,
      textarea {
        font: inherit;
      }

      button {
        color: inherit;
      }

      .chat-shell {
        display: grid;
        grid-template-rows: 40px 32px minmax(0, 1fr) auto;
        min-height: 100vh;
      }

      .mode-tabs {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorGroupHeader-tabsBackground);
      }

      .mode-tab {
        display: flex;
        min-width: 0;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 0 8px;
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
        box-shadow: inset 0 -1px 0 var(--vscode-focusBorder);
      }

      .mode-tab:hover {
        background: var(--vscode-list-hoverBackground);
        color: var(--vscode-tab-activeForeground);
      }

      .mode-tab:focus-visible,
      .session-tab:focus-visible,
      .new-session:focus-visible,
      .composer:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .mode-tab svg,
      .new-session svg {
        flex: 0 0 16px;
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
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editorGroupHeader-tabsBackground);
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
        flex: 0 0 32px;
        width: 32px;
        padding: 0;
        place-items: center;
        border: 0;
        background: transparent;
        cursor: pointer;
      }

      .new-session:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }

      .mode-panel {
        min-height: 0;
        overflow: auto;
      }

      .session-surface {
        display: grid;
        min-height: 100%;
        place-items: center;
        padding: 16px;
        color: var(--vscode-descriptionForeground);
        text-align: center;
      }

      .session-surface p,
      .workflow-surface p {
        margin: 0;
        line-height: 1.5;
      }

      .workflow-surface {
        padding: 16px;
        color: var(--vscode-descriptionForeground);
      }

      .composer-region {
        padding: 8px;
        border-top: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
      }

      .composer {
        display: block;
        width: 100%;
        min-height: 72px;
        resize: vertical;
        padding: 8px;
        border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
        border-radius: 3px;
        outline: 0;
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
      }

      .composer::placeholder {
        color: var(--vscode-input-placeholderForeground);
      }

      [hidden] {
        display: none !important;
      }
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
        </button>
        <button class="mode-tab" type="button" role="tab" data-mode="workflow" aria-selected="false" tabindex="-1">
          <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
            <circle cx="4" cy="4" r="1.75"></circle>
            <circle cx="12" cy="12" r="1.75"></circle>
            <circle cx="4" cy="12" r="1.75"></circle>
            <path d="m5.4 5.2 5.1 5.1M5.75 12h4.5"></path>
          </svg>
          <span>Workflow Session</span>
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
        <div class="session-surface">
          <p>로컬 세션의 메시지는 backend 연결 Work Unit에서 제공됩니다.</p>
        </div>
      </section>
      <section class="mode-panel workflow-surface" role="tabpanel" data-mode-panel="workflow" hidden>
        <p>Workflow 실행 연결은 이번 포팅 범위에 포함되지 않습니다.</p>
      </section>
      <footer class="composer-region">
        <textarea
          class="composer"
          aria-label="Session draft"
          placeholder="세션 메모를 입력하세요..."
          data-composer
        ></textarea>
      </footer>
    </main>
    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const modeTabs = Array.from(document.querySelectorAll('[data-mode]'));
        const modePanels = Array.from(document.querySelectorAll('[data-mode-panel]'));
        const sessionTabs = document.querySelector('[data-session-tabs]');
        const newSession = document.querySelector('[data-new-session]');
        const composer = document.querySelector('[data-composer]');
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
        };

        function activeSession() {
          return state.sessions.find((session) => session.id === state.activeSessionId)
            || state.sessions[0];
        }

        function persist() {
          vscode.setState({
            activeMode: state.activeMode,
            sessions: state.sessions,
            activeSessionId: state.activeSessionId,
            nextSessionNumber: state.nextSessionNumber,
          });
        }

        function activateMode(mode, options = {}) {
          if (!modeTabs.some((tab) => tab.dataset.mode === mode)) {
            return;
          }
          state.activeMode = mode;
          for (const tab of modeTabs) {
            const selected = tab.dataset.mode === mode;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;
            if (selected && options.focus) {
              tab.focus();
            }
          }
          for (const panel of modePanels) {
            panel.hidden = panel.dataset.modePanel !== mode;
          }
          composer.parentElement.hidden = mode !== "main";
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
              renderSessions();
              composer.value = activeSession().draft;
              persist();
            });
            sessionTabs.append(tab);
          }
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
          renderSessions();
          composer.value = "";
          composer.focus();
          persist();
        });

        composer.addEventListener("input", () => {
          activeSession().draft = composer.value;
          persist();
        });

        renderSessions();
        composer.value = activeSession().draft;
        activateMode(state.activeMode);
      })();
    </script>
  </body>
</html>`;
}

module.exports = {
  CHAT_VIEW_ID,
  AgentsChatViewProvider,
  createChatViewHtml,
};

