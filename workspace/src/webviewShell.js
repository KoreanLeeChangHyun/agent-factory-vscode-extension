"use strict";

const TAB_DEFINITIONS = Object.freeze([
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Dashboard 기능은 후속 Work Unit에서 구현됩니다.",
  },
  {
    id: "design",
    label: "Design",
    description: "Design 기능은 후속 Work Unit에서 구현됩니다.",
  },
  {
    id: "kanban",
    label: "Kanban",
    description: "Work Unit 보드는 후속 Work Unit에서 구현됩니다.",
  },
  {
    id: "context",
    label: "Context",
    description: "Context 기능은 후속 Work Unit에서 구현됩니다.",
  },
  {
    id: "view",
    label: "View",
    description: "Agent Factory 산출물 열람은 후속 Work Unit에서 구현됩니다.",
  },
]);

function createWebviewHtml({ cspSource, nonce }) {
  if (!cspSource || !nonce) {
    throw new TypeError("cspSource and nonce are required");
  }

  const tabs = TAB_DEFINITIONS.map(
    ({ id, label }, index) => `
      <button
        class="workspace-tab"
        id="tab-${id}"
        type="button"
        role="tab"
        aria-controls="panel-${id}"
        aria-selected="${index === 0}"
        data-tab-id="${id}"
        tabindex="${index === 0 ? "0" : "-1"}"
      >${label}</button>`,
  ).join("");

  const panels = TAB_DEFINITIONS.map(
    ({ id, label, description }, index) => `
      <section
        class="workspace-panel"
        id="panel-${id}"
        role="tabpanel"
        aria-labelledby="tab-${id}"
        data-panel-id="${id}"
        ${index === 0 ? "" : "hidden"}
      >
        <div class="empty-state">
          <h2>${label}</h2>
          <p>${description}</p>
        </div>
      </section>`,
  ).join("");

  return `<!DOCTYPE html>
<html lang="ko">
  <head>
    <meta charset="UTF-8">
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';"
    >
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Agent Factory Workspace</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: var(--vscode-font-family);
        font-size: var(--vscode-font-size);
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }

      * {
        box-sizing: border-box;
      }

      body {
        min-width: 320px;
        min-height: 100vh;
        margin: 0;
        background: var(--vscode-editor-background);
      }

      button {
        font: inherit;
      }

      .workspace-shell {
        display: grid;
        min-height: 100vh;
        grid-template-rows: auto auto minmax(0, 1fr);
      }

      .workspace-tabs {
        display: flex;
        gap: 2px;
        min-width: 0;
        padding: 8px clamp(12px, 2vw, 24px) 0;
        overflow-x: auto;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(
          --vscode-editorGroupHeader-tabsBackground,
          var(--vscode-sideBar-background)
        );
      }

      .workspace-tab {
        position: relative;
        flex: 0 0 auto;
        min-height: 34px;
        padding: 6px 12px 8px;
        border: 0;
        color: var(--vscode-tab-inactiveForeground);
        background: var(--vscode-tab-inactiveBackground, transparent);
        cursor: pointer;
      }

      .workspace-tab:hover {
        color: var(--vscode-tab-activeForeground);
        background: var(
          --vscode-tab-hoverBackground,
          var(--vscode-list-hoverBackground)
        );
      }

      .workspace-tab[aria-selected="true"] {
        color: var(--vscode-tab-activeForeground);
        background: var(--vscode-tab-activeBackground);
      }

      .workspace-tab[aria-selected="true"]::after {
        position: absolute;
        right: 8px;
        bottom: 0;
        left: 8px;
        height: 2px;
        content: "";
        background: var(--vscode-tab-activeBorder, var(--vscode-focusBorder));
      }

      .workspace-tab:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
      }

      .selected-header {
        display: flex;
        min-height: 44px;
        align-items: center;
        padding: 0 clamp(16px, 2.5vw, 32px);
        border-bottom: 1px solid
          var(--vscode-editorWidget-border, var(--vscode-panel-border));
        background: var(
          --vscode-editorWidget-background,
          var(--vscode-editor-background)
        );
      }

      .selected-header h1 {
        margin: 0;
        overflow: hidden;
        font-size: 13px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .workspace-body {
        min-height: 0;
        overflow: auto;
      }

      .workspace-panel {
        min-height: 100%;
        padding: clamp(20px, 3vw, 40px);
      }

      .empty-state {
        width: min(100%, 720px);
        margin-inline: auto;
        padding: clamp(24px, 3vw, 36px);
        border: 1px solid
          var(--vscode-editorWidget-border, var(--vscode-panel-border));
        border-radius: 6px;
        background: var(--vscode-editorWidget-background);
      }

      .empty-state h2 {
        margin: 0 0 8px;
        font-size: 18px;
      }

      .empty-state p {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        line-height: 1.5;
      }

      [hidden] {
        display: none !important;
      }
    </style>
  </head>
  <body>
    <main class="workspace-shell">
      <nav class="workspace-tabs" role="tablist" aria-label="Agent Factory workspace">
        ${tabs}
      </nav>
      <header class="selected-header">
        <h1 data-selected-title>Dashboard</h1>
      </header>
      <div class="workspace-body">
        ${panels}
      </div>
    </main>
    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
        const panels = Array.from(document.querySelectorAll('[role="tabpanel"]'));
        const selectedTitle = document.querySelector('[data-selected-title]');
        const state = vscode.getState() || {};
        const knownTabs = new Set(tabs.map((tab) => tab.dataset.tabId));

        function activateTab(tabId, options = {}) {
          if (!knownTabs.has(tabId)) {
            return;
          }

          for (const tab of tabs) {
            const selected = tab.dataset.tabId === tabId;
            tab.setAttribute("aria-selected", String(selected));
            tab.tabIndex = selected ? 0 : -1;

            if (selected && options.focus) {
              tab.focus();
            }
          }

          for (const panel of panels) {
            panel.hidden = panel.dataset.panelId !== tabId;
          }

          const activeTab = tabs.find((tab) => tab.dataset.tabId === tabId);
          selectedTitle.textContent = activeTab.textContent.trim();
          vscode.setState({ selectedTab: tabId });
        }

        for (const [index, tab] of tabs.entries()) {
          tab.addEventListener("click", () => {
            activateTab(tab.dataset.tabId);
          });

          tab.addEventListener("keydown", (event) => {
            let targetIndex;

            if (event.key === "ArrowLeft") {
              targetIndex = (index - 1 + tabs.length) % tabs.length;
            } else if (event.key === "ArrowRight") {
              targetIndex = (index + 1) % tabs.length;
            } else if (event.key === "Home") {
              targetIndex = 0;
            } else if (event.key === "End") {
              targetIndex = tabs.length - 1;
            } else {
              return;
            }

            event.preventDefault();
            activateTab(tabs[targetIndex].dataset.tabId, { focus: true });
          });
        }

        activateTab(knownTabs.has(state.selectedTab) ? state.selectedTab : "dashboard");
      })();
    </script>
  </body>
</html>`;
}

module.exports = {
  TAB_DEFINITIONS,
  createWebviewHtml,
};
