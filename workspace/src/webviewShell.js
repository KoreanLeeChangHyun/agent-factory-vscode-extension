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
    description: "Canonical Work Unit lifecycle board",
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

const KANBAN_COLUMNS = Object.freeze([
  { id: "backlog", label: "Backlog" },
  { id: "ready", label: "Ready" },
  { id: "working", label: "Working" },
  { id: "review", label: "Review" },
  { id: "done", label: "Done" },
  { id: "blocked", label: "Blocked" },
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

  const kanbanColumns = KANBAN_COLUMNS.map(
    ({ id, label }) => `
      <section class="kanban-column" data-kanban-column="${id}" aria-labelledby="kanban-column-${id}">
        <header class="kanban-column-header">
          <h3 id="kanban-column-${id}">${label}</h3>
          <span class="kanban-count" data-column-count aria-label="${label} 항목 수">0</span>
        </header>
        <div class="kanban-card-list" data-card-list>
          <p class="kanban-column-empty">항목 없음</p>
        </div>
      </section>`,
  ).join("");

  const panels = TAB_DEFINITIONS.map((definition, index) => {
    const { id, label, description } = definition;
    const content =
      id === "kanban"
        ? `
        <div class="kanban-workspace" aria-busy="true">
          <div class="kanban-toolbar">
            <label class="kanban-filter-label">
              <span>Work Unit 필터</span>
              <input
                type="search"
                data-kanban-filter
                placeholder="제목 또는 id"
                autocomplete="off"
              >
            </label>
            <button class="secondary-button" type="button" data-kanban-refresh>새로 고침</button>
            <span class="kanban-updated" data-kanban-updated aria-live="polite">불러오는 중…</span>
          </div>
          <div class="kanban-notice" data-kanban-notice role="status" aria-live="polite"></div>
          <div class="kanban-errors" data-kanban-errors role="alert" hidden></div>
          <div class="kanban-board" aria-label="Work Unit lifecycle board">
            ${kanbanColumns}
          </div>
        </div>`
        : `
        <div class="empty-state">
          <h2>${label}</h2>
          <p>${description}</p>
        </div>`;

    return `
      <section
        class="workspace-panel"
        id="panel-${id}"
        role="tabpanel"
        aria-labelledby="tab-${id}"
        data-panel-id="${id}"
        ${index === 0 ? "" : "hidden"}
      >
        ${content}
      </section>`;
  }).join("");

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
        padding: 0;
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
        padding: 0;
        overflow-x: auto;
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(
          --vscode-editorGroupHeader-tabsBackground,
          var(--vscode-sideBar-background)
        );
      }

      .workspace-tab {
        position: relative;
        flex: 1 1 0;
        min-width: 0;
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
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
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
        background: var(--vscode-editor-background);
      }

      .workspace-panel {
        min-height: 100%;
        padding: 0;
      }

      .empty-state {
        width: 100%;
        min-height: 100%;
        margin: 0;
        padding: clamp(24px, 3vw, 36px);
        background: var(--vscode-editor-background);
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

      .kanban-workspace {
        min-height: 100%;
        padding: 16px;
      }

      .kanban-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        align-items: end;
        margin-bottom: 12px;
      }

      .kanban-filter-label {
        display: grid;
        flex: 1 1 260px;
        gap: 4px;
        max-width: 520px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .kanban-filter-label input,
      .kanban-card select {
        min-height: 28px;
        border: 1px solid var(--vscode-input-border, transparent);
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
      }

      .kanban-filter-label input {
        padding: 4px 8px;
      }

      .kanban-filter-label input:focus-visible,
      .kanban-card select:focus-visible,
      .secondary-button:focus-visible,
      .move-button:focus-visible,
      .kanban-card:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .secondary-button,
      .move-button {
        min-height: 28px;
        padding: 4px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
        cursor: pointer;
      }

      .secondary-button:hover,
      .move-button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

      .kanban-updated {
        min-height: 28px;
        padding: 6px 0;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .kanban-notice,
      .kanban-errors {
        min-height: 20px;
        margin-bottom: 8px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        line-height: 1.4;
      }

      .kanban-errors {
        padding: 8px 10px;
        border: 1px solid var(--vscode-inputValidation-warningBorder);
        color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
        background: var(--vscode-inputValidation-warningBackground);
      }

      .kanban-board {
        display: grid;
        grid-template-columns: repeat(6, minmax(230px, 1fr));
        gap: 10px;
        min-width: 1430px;
        align-items: start;
      }

      .kanban-column {
        min-height: 180px;
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
      }

      .kanban-column.is-drop-target {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: -2px;
        background: var(--vscode-list-dropBackground);
      }

      .kanban-column-header {
        display: flex;
        min-height: 38px;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .kanban-column-header h3 {
        margin: 0;
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
      }

      .kanban-count {
        min-width: 22px;
        padding: 1px 6px;
        border-radius: 10px;
        color: var(--vscode-badge-foreground);
        background: var(--vscode-badge-background);
        text-align: center;
      }

      .kanban-card-list {
        display: grid;
        gap: 8px;
        padding: 8px;
      }

      .kanban-column-empty {
        margin: 12px 4px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-align: center;
      }

      .kanban-card {
        display: grid;
        gap: 7px;
        padding: 10px;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }

      .kanban-card[draggable="true"] {
        cursor: grab;
      }

      .kanban-card[aria-grabbed="true"] {
        opacity: 0.65;
        cursor: grabbing;
      }

      .kanban-card-title {
        margin: 0;
        overflow-wrap: anywhere;
        font-size: 13px;
        line-height: 1.35;
      }

      .kanban-card-id,
      .kanban-card-meta {
        margin: 0;
        color: var(--vscode-descriptionForeground);
        font-size: 11px;
        line-height: 1.35;
        overflow-wrap: anywhere;
      }

      .kanban-card-actions {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 6px;
      }

      .kanban-card select {
        min-width: 0;
        padding: 3px 5px;
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
        const filterInput = document.querySelector('[data-kanban-filter]');
        const refreshButton = document.querySelector('[data-kanban-refresh]');
        const updatedLabel = document.querySelector('[data-kanban-updated]');
        const notice = document.querySelector('[data-kanban-notice]');
        const errors = document.querySelector('[data-kanban-errors]');
        const kanbanWorkspace = document.querySelector('.kanban-workspace');
        const kanbanColumns = Array.from(document.querySelectorAll('[data-kanban-column]'));
        const state = { selectedTab: "dashboard", kanbanFilter: "", ...(vscode.getState() || {}) };
        const knownTabs = new Set(tabs.map((tab) => tab.dataset.tabId));
        let snapshot;
        let dragState;
        let transitionSequence = 0;
        const pendingWorkUnits = new Set();

        function persistState() {
          vscode.setState(state);
        }

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
          state.selectedTab = tabId;
          persistState();
        }

        function appendTextElement(parent, tagName, className, text) {
          const element = document.createElement(tagName);
          element.className = className;
          element.textContent = text;
          parent.append(element);
          return element;
        }

        function formatMeta(card) {
          const values = [];
          if (card.execution) {
            values.push(
              "실행 " +
                (card.execution.state || "unknown") +
                " · r" +
                (card.execution.revision || "-") +
                " a" +
                (card.execution.attempt || "-"),
            );
          }
          if (card.humanReviewStatus) {
            values.push("Human review " + card.humanReviewStatus);
          }
          if (card.integrationStatus) {
            values.push("Integration " + card.integrationStatus);
          }
          if (card.pullRequestStatus) {
            values.push("PR " + card.pullRequestStatus);
          }
          return values.join(" · ");
        }

        function requestTransition(card, targetStatus) {
          const capability = card.capabilities.find(
            (candidate) => candidate.target === targetStatus,
          );
          if (!capability?.allowed) {
            notice.textContent =
              capability?.reason || "현재 상태에서 허용되지 않는 전이입니다.";
            return;
          }
          if (pendingWorkUnits.has(card.id)) {
            notice.textContent = card.id + " 상태 전이가 이미 진행 중입니다.";
            return;
          }
          const requestId = "transition-" + Date.now() + "-" + ++transitionSequence;
          pendingWorkUnits.add(card.id);
          notice.textContent = card.id + " → " + targetStatus + " 전이 요청 중…";
          kanbanWorkspace.setAttribute("aria-busy", "true");
          renderKanban();
          vscode.postMessage({
            type: "kanban.transition",
            requestId,
            workUnitId: card.id,
            fromStatus: card.status,
            targetStatus,
            snapshotGeneratedAt: snapshot.generatedAt,
          });
        }

        function createCard(card) {
          const cardElement = document.createElement("article");
          cardElement.className = "kanban-card";
          cardElement.dataset.workUnitId = card.id;
          cardElement.tabIndex = 0;

          const allowedCapabilities = card.capabilities.filter((capability) => capability.allowed);
          const pending = pendingWorkUnits.has(card.id);
          cardElement.draggable = !pending && allowedCapabilities.length > 0;
          cardElement.setAttribute("aria-grabbed", "false");
          cardElement.setAttribute("aria-busy", String(pending));

          appendTextElement(cardElement, "h4", "kanban-card-title", card.title);
          appendTextElement(cardElement, "p", "kanban-card-id", card.id);
          const meta = formatMeta(card);
          if (meta) {
            appendTextElement(cardElement, "p", "kanban-card-meta", meta);
          }

          const actions = document.createElement("div");
          actions.className = "kanban-card-actions";
          const moveTarget = document.createElement("select");
          moveTarget.dataset.moveTarget = "";
          moveTarget.setAttribute("aria-label", card.title + " 이동 대상");
          const placeholder = document.createElement("option");
          placeholder.value = "";
          placeholder.textContent = "Move…";
          moveTarget.append(placeholder);
          for (const capability of card.capabilities) {
            if (capability.target === card.status) {
              continue;
            }
            const option = document.createElement("option");
            option.value = capability.target;
            option.textContent = capability.allowed
              ? capability.target
              : capability.target + " — " + capability.reason;
            option.title = capability.reason;
            option.disabled = !capability.allowed;
            moveTarget.append(option);
          }
          moveTarget.disabled = pending || allowedCapabilities.length === 0;
          const moveButton = document.createElement("button");
          moveButton.className = "move-button";
          moveButton.type = "button";
          moveButton.dataset.moveButton = "";
          moveButton.textContent = "Move";
          moveButton.disabled = pending || allowedCapabilities.length === 0;
          moveButton.addEventListener("click", () => {
            if (moveTarget.value) {
              requestTransition(card, moveTarget.value);
            }
          });
          actions.append(moveTarget, moveButton);
          cardElement.append(actions);

          cardElement.addEventListener("dragstart", (event) => {
            const allowedTargets = new Set(
              allowedCapabilities.map((capability) => capability.target),
            );
            dragState = { card, allowedTargets };
            cardElement.setAttribute("aria-grabbed", "true");
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", card.id);
          });
          cardElement.addEventListener("dragend", () => {
            dragState = undefined;
            cardElement.setAttribute("aria-grabbed", "false");
            for (const column of kanbanColumns) {
              column.classList.remove("is-drop-target");
            }
          });

          return cardElement;
        }

        function renderKanban() {
          if (!snapshot) {
            return;
          }
          const filter = state.kanbanFilter.trim().toLocaleLowerCase("ko-KR");
          for (const column of kanbanColumns) {
            const model = snapshot.columns.find(
              (candidate) => candidate.id === column.dataset.kanbanColumn,
            );
            const cards = (model?.cards || []).filter((card) => {
              const searchable = (card.title + " " + card.id).toLocaleLowerCase("ko-KR");
              return !filter || searchable.includes(filter);
            });
            const cardList = column.querySelector('[data-card-list]');
            const count = column.querySelector('[data-column-count]');
            count.textContent = String(cards.length);
            cardList.replaceChildren();
            if (cards.length === 0) {
              appendTextElement(cardList, "p", "kanban-column-empty", "항목 없음");
            } else {
              cardList.append(...cards.map(createCard));
            }
          }

          const snapshotErrors = Array.isArray(snapshot.errors) ? snapshot.errors : [];
          errors.hidden = snapshotErrors.length === 0;
          errors.textContent = snapshotErrors
            .map((error) => (error.workUnitId ? error.workUnitId + ": " : "") + error.message)
            .join("\\n");
          updatedLabel.textContent =
            "갱신 " + new Date(snapshot.generatedAt).toLocaleString("ko-KR");
          kanbanWorkspace.setAttribute("aria-busy", "false");
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

        for (const column of kanbanColumns) {
          column.addEventListener("dragover", (event) => {
            const allowedTargets = dragState?.allowedTargets || new Set();
            if (allowedTargets.has(column.dataset.kanbanColumn)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              column.classList.add("is-drop-target");
            }
          });
          column.addEventListener("dragleave", () => {
            column.classList.remove("is-drop-target");
          });
          column.addEventListener("drop", (event) => {
            event.preventDefault();
            column.classList.remove("is-drop-target");
            const allowedTargets = dragState?.allowedTargets || new Set();
            if (dragState && allowedTargets.has(column.dataset.kanbanColumn)) {
              requestTransition(dragState.card, column.dataset.kanbanColumn);
            }
          });
        }

        filterInput.value = state.kanbanFilter;
        filterInput.addEventListener("input", () => {
          state.kanbanFilter = filterInput.value;
          persistState();
          renderKanban();
        });
        refreshButton.addEventListener("click", () => {
          kanbanWorkspace.setAttribute("aria-busy", "true");
          vscode.postMessage({ type: "kanban.refresh" });
        });
        window.addEventListener("message", (event) => {
          const message = event.data;
          if (!message || typeof message !== "object") {
            return;
          }
          if (
            message.type === "kanban.snapshot" &&
            message.snapshot?.schemaVersion === "1.0.0"
          ) {
            snapshot = message.snapshot;
            notice.textContent = "";
            renderKanban();
          } else if (message.type === "kanban.error") {
            kanbanWorkspace.setAttribute("aria-busy", "false");
            errors.hidden = false;
            errors.textContent = message.error?.message || "Kanban을 불러오지 못했습니다.";
            updatedLabel.textContent = "갱신 실패";
          } else if (message.type === "kanban.transitionPending") {
            pendingWorkUnits.add(message.workUnitId);
            notice.textContent =
              message.workUnitId + " → " + message.targetStatus + " manager 검증 중…";
            kanbanWorkspace.setAttribute("aria-busy", "true");
            renderKanban();
          } else if (message.type === "kanban.transitionResult") {
            pendingWorkUnits.delete(message.workUnitId);
            kanbanWorkspace.setAttribute("aria-busy", "false");
            if (message.ok) {
              notice.textContent =
                message.workUnitId + " → " + message.targetStatus + " 전이가 완료되었습니다.";
              errors.hidden = true;
            } else {
              notice.textContent = "상태 전이가 적용되지 않았습니다.";
              errors.hidden = false;
              errors.textContent =
                message.error?.message || "Work Unit manager가 전이를 거부했습니다.";
            }
            renderKanban();
          }
        });

        activateTab(knownTabs.has(state.selectedTab) ? state.selectedTab : "dashboard");
        vscode.postMessage({ type: "kanban.ready" });
      })();
    </script>
  </body>
</html>`;
}

module.exports = {
  KANBAN_COLUMNS,
  TAB_DEFINITIONS,
  createWebviewHtml,
};
