"use strict";

const TAB_DEFINITIONS = Object.freeze([
  {
    id: "dashboard",
    label: "Dashboard",
    description: "Dashboard 기능은 후속 Work Unit에서 구현됩니다.",
  },
  {
    id: "editor",
    label: "Editor",
    description: "Canonical Agent Factory artifact editor",
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

  const kanbanBoardTabs = KANBAN_COLUMNS.map(
    ({ id, label }, index) => `
      <button
        class="kanban-board-tab"
        id="kanban-board-tab-${id}"
        type="button"
        role="tab"
        aria-controls="kanban-column-${id}"
        aria-selected="${index === 0}"
        data-kanban-board-target="${id}"
        tabindex="${index === 0 ? "0" : "-1"}"
      >
        <span>${label}</span>
        <span class="kanban-count" data-board-count aria-label="${label} 항목 수">0</span>
      </button>`,
  ).join("");

  const kanbanColumns = KANBAN_COLUMNS.map(
    ({ id }, index) => `
      <section
        class="kanban-column"
        id="kanban-column-${id}"
        role="tabpanel"
        aria-labelledby="kanban-board-tab-${id}"
        data-kanban-column="${id}"
        ${index === 0 ? "" : "hidden"}
      >
        <div class="kanban-card-list" data-card-list>
          <p class="kanban-column-empty">항목 없음</p>
        </div>
      </section>`,
  ).join("");

  const panels = TAB_DEFINITIONS.map((definition, index) => {
    const { id, label, description } = definition;
    let content;
    if (id === "kanban") {
      content = `
        <div class="kanban-workspace" aria-busy="true">
          <div class="kanban-toolbar">
            <button class="secondary-button" type="button" data-kanban-refresh>새로 고침</button>
            <span class="kanban-updated" data-kanban-updated aria-live="polite">불러오는 중…</span>
          </div>
          <div class="kanban-notice" data-kanban-notice role="status" aria-live="polite"></div>
          <div class="kanban-errors" data-kanban-errors role="alert" hidden></div>
          <div class="kanban-board" aria-label="Work Unit lifecycle board">
            ${kanbanColumns}
          </div>
        </div>`;
    } else if (id === "editor") {
      content = `
        <div class="artifact-editor" aria-busy="true">
          <aside class="artifact-browser" aria-label="Artifact browser">
            <div class="artifact-browser-header">
              <strong>Artifacts</strong>
              <button class="secondary-button" type="button" data-editor-refresh>새로 고침</button>
            </div>
            <div class="artifact-list" data-editor-artifacts></div>
            <div class="section-list" data-editor-sections></div>
            <div class="item-list" data-editor-items></div>
          </aside>
          <section class="artifact-detail" aria-label="Artifact editor">
            <div class="artifact-editor-status" data-editor-status role="status" aria-live="polite">
              artifact를 선택하세요.
            </div>
            <div class="artifact-editor-error" data-editor-error role="alert" hidden></div>
            <div class="artifact-fields" data-editor-fields></div>
            <div class="artifact-preview-shell">
              <h2>Read-only JSON</h2>
              <pre class="artifact-preview" data-editor-preview tabindex="0"></pre>
            </div>
          </section>
        </div>`;
    } else {
      content = `
        <div class="empty-state">
          <h2>${label}</h2>
          <p>${description}</p>
        </div>`;
    }

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
        gap: clamp(12px, 2vw, 24px);
        min-width: 0;
        padding: 0 clamp(16px, 2.5vw, 32px);
        border-bottom: 1px solid var(--vscode-panel-border);
        background: var(--vscode-editor-background);
      }

      .selected-header h1 {
        flex: 0 0 auto;
        margin: 0;
        overflow: hidden;
        font-size: 13px;
        font-weight: 600;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .kanban-board-selector {
        display: flex;
        flex: 1 1 auto;
        gap: 0;
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
      }

      .kanban-board-selector::-webkit-scrollbar {
        display: none;
      }

      .kanban-board-tab {
        position: relative;
        display: flex;
        flex: 1 0 88px;
        min-width: 88px;
        min-height: 43px;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 6px 8px;
        border: 0;
        border-left: 1px solid var(--vscode-panel-border);
        color: var(--vscode-tab-inactiveForeground);
        background: transparent;
        cursor: pointer;
      }

      .kanban-board-tab:last-child {
        border-right: 1px solid var(--vscode-panel-border);
      }

      .kanban-board-tab:hover,
      .kanban-board-tab.is-drop-target {
        color: var(--vscode-tab-activeForeground);
        background: var(--vscode-list-hoverBackground);
      }

      .kanban-board-tab.is-drop-target {
        outline: 2px solid var(--vscode-focusBorder);
        outline-offset: -2px;
        background: var(--vscode-list-dropBackground);
      }

      .kanban-board-tab[aria-selected="true"] {
        color: var(--vscode-tab-activeForeground);
        background: var(--vscode-tab-activeBackground);
      }

      .kanban-board-tab[aria-selected="true"]::after {
        position: absolute;
        right: 0;
        bottom: 0;
        left: 0;
        height: 2px;
        content: "";
        background: var(--vscode-tab-activeBorder, var(--vscode-focusBorder));
      }

      .kanban-board-tab:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: -1px;
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

      .artifact-editor {
        display: grid;
        min-height: calc(100vh - 78px);
        grid-template-columns: minmax(220px, 28%) minmax(0, 1fr);
      }

      .artifact-browser {
        min-width: 0;
        padding: 12px;
        overflow: auto;
        border-right: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
      }

      .artifact-browser-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        margin-bottom: 10px;
      }

      .artifact-list,
      .section-list,
      .item-list {
        display: grid;
        gap: 3px;
        margin-bottom: 12px;
      }

      .section-list,
      .item-list {
        padding-top: 10px;
        border-top: 1px solid var(--vscode-panel-border);
      }

      .artifact-tree-button {
        min-width: 0;
        padding: 6px 8px;
        overflow: hidden;
        border: 0;
        color: var(--vscode-foreground);
        background: transparent;
        text-align: left;
        text-overflow: ellipsis;
        white-space: nowrap;
        cursor: pointer;
      }

      .artifact-tree-button:hover,
      .artifact-tree-button[aria-current="true"] {
        background: var(--vscode-list-hoverBackground);
      }

      .artifact-tree-button[aria-current="true"] {
        color: var(--vscode-list-activeSelectionForeground);
        background: var(--vscode-list-activeSelectionBackground);
      }

      .artifact-detail {
        min-width: 0;
        padding: 16px;
        overflow: auto;
      }

      .artifact-editor-status,
      .artifact-editor-error {
        min-height: 22px;
        margin-bottom: 10px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .artifact-editor-error {
        padding: 8px 10px;
        border: 1px solid var(--vscode-inputValidation-errorBorder);
        color: var(--vscode-inputValidation-errorForeground, var(--vscode-foreground));
        background: var(--vscode-inputValidation-errorBackground);
      }

      .artifact-fields {
        display: grid;
        gap: 10px;
        margin-bottom: 16px;
      }

      .artifact-field {
        display: grid;
        gap: 4px;
      }

      .artifact-field label,
      .artifact-preview-shell h2 {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        font-weight: 600;
      }

      .artifact-field input,
      .artifact-field textarea {
        width: 100%;
        min-height: 28px;
        padding: 5px 7px;
        border: 1px solid var(--vscode-input-border, transparent);
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
        font: inherit;
      }

      .artifact-field textarea {
        min-height: 88px;
        resize: vertical;
      }

      .artifact-save-row {
        display: flex;
        justify-content: flex-end;
      }

      .artifact-preview-shell {
        border-top: 1px solid var(--vscode-panel-border);
      }

      .artifact-preview {
        min-height: 220px;
        margin: 0;
        padding: 12px;
        overflow: auto;
        border: 1px solid var(--vscode-panel-border);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-textCodeBlock-background);
        font-family: var(--vscode-editor-font-family);
        font-size: var(--vscode-editor-font-size);
        white-space: pre;
      }

      @media (max-width: 720px) {
        .artifact-editor {
          grid-template-columns: 1fr;
        }

        .artifact-browser {
          max-height: 42vh;
          border-right: 0;
          border-bottom: 1px solid var(--vscode-panel-border);
        }
      }

      .kanban-workspace {
        display: grid;
        height: calc(100vh - 78px);
        min-height: 0;
        grid-template-rows: auto auto auto minmax(0, 1fr);
        padding: 12px 16px 0;
        overflow: hidden;
      }

      .kanban-toolbar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
        min-height: 32px;
        margin-bottom: 8px;
      }

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
        min-width: 0;
        min-height: 28px;
        padding: 6px 0;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
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

      .kanban-notice:empty {
        min-height: 0;
        margin-bottom: 0;
      }

      .kanban-board {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 0;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      .kanban-column {
        display: grid;
        height: 100%;
        min-height: 0;
        grid-template-rows: minmax(0, 1fr);
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
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
        min-height: 0;
        align-content: start;
        gap: 8px;
        padding: 8px;
        overflow-y: auto;
        scrollbar-width: none;
      }

      .kanban-card-list::-webkit-scrollbar {
        display: none;
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
        min-height: 28px;
        padding: 3px 5px;
        border: 1px solid var(--vscode-input-border, transparent);
        color: var(--vscode-input-foreground);
        background: var(--vscode-input-background);
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
        <div
          class="kanban-board-selector"
          data-kanban-board-selector
          role="tablist"
          aria-label="Kanban boards"
          hidden
        >
          ${kanbanBoardTabs}
        </div>
      </header>
      <div class="workspace-body">
        ${panels}
      </div>
    </main>
    <script nonce="${nonce}">
      (() => {
        const vscode = acquireVsCodeApi();
        const tabs = Array.from(document.querySelectorAll('[data-tab-id]'));
        const panels = Array.from(document.querySelectorAll('[data-panel-id]'));
        const selectedTitle = document.querySelector('[data-selected-title]');
        const kanbanBoardSelector = document.querySelector('[data-kanban-board-selector]');
        const kanbanBoardTabs = Array.from(
          document.querySelectorAll('[data-kanban-board-target]'),
        );
        const refreshButton = document.querySelector('[data-kanban-refresh]');
        const updatedLabel = document.querySelector('[data-kanban-updated]');
        const notice = document.querySelector('[data-kanban-notice]');
        const errors = document.querySelector('[data-kanban-errors]');
        const kanbanWorkspace = document.querySelector('.kanban-workspace');
        const kanbanColumns = Array.from(document.querySelectorAll('[data-kanban-column]'));
        const artifactList = document.querySelector('[data-editor-artifacts]');
        const sectionList = document.querySelector('[data-editor-sections]');
        const itemList = document.querySelector('[data-editor-items]');
        const editorFields = document.querySelector('[data-editor-fields]');
        const editorPreview = document.querySelector('[data-editor-preview]');
        const editorStatus = document.querySelector('[data-editor-status]');
        const editorError = document.querySelector('[data-editor-error]');
        const editorRefresh = document.querySelector('[data-editor-refresh]');
        const artifactEditor = document.querySelector('.artifact-editor');
        const state = {
          selectedTab: "dashboard",
          selectedKanbanBoard: "backlog",
          selectedArtifactType: "",
          selectedArtifactId: "",
          selectedSectionId: "",
          selectedItemId: "",
          ...(vscode.getState() || {}),
        };
        delete state.kanbanFilter;
        if (["design", "view"].includes(state.selectedTab)) {
          state.selectedTab = "editor";
        }
        const knownTabs = new Set(tabs.map((tab) => tab.dataset.tabId));
        const knownKanbanBoards = new Set(
          kanbanBoardTabs.map((tab) => tab.dataset.kanbanBoardTarget),
        );
        if (!knownKanbanBoards.has(state.selectedKanbanBoard)) {
          state.selectedKanbanBoard = "backlog";
        }
        let snapshot;
        let artifactIndex;
        let artifactDocument;
        let dragState;
        let transitionSequence = 0;
        let editorSaveSequence = 0;
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
          kanbanBoardSelector.hidden = tabId !== "kanban";
          state.selectedTab = tabId;
          persistState();
        }

        function selectKanbanBoard(boardId, options = {}) {
          if (!knownKanbanBoards.has(boardId)) {
            return;
          }

          state.selectedKanbanBoard = boardId;
          for (const boardTab of kanbanBoardTabs) {
            const selected = boardTab.dataset.kanbanBoardTarget === boardId;
            boardTab.setAttribute("aria-selected", String(selected));
            boardTab.tabIndex = selected ? 0 : -1;
            if (selected) {
              boardTab.scrollIntoView({ block: "nearest", inline: "nearest" });
              if (options.focus) {
                boardTab.focus();
              }
            }
          }
          for (const column of kanbanColumns) {
            column.hidden = column.dataset.kanbanColumn !== boardId;
          }
          persistState();
        }

        function appendTextElement(parent, tagName, className, text) {
          const element = document.createElement(tagName);
          element.className = className;
          element.textContent = text;
          parent.append(element);
          return element;
        }

        function createTreeButton(label, selected, onSelect) {
          const button = document.createElement("button");
          button.className = "artifact-tree-button";
          button.type = "button";
          button.textContent = label;
          button.title = label;
          button.setAttribute("aria-current", String(selected));
          button.addEventListener("click", onSelect);
          return button;
        }

        function requestArtifact(artifactType, artifactId, resetSelection = true) {
          state.selectedArtifactType = artifactType;
          state.selectedArtifactId = artifactId;
          if (resetSelection) {
            state.selectedSectionId = "";
            state.selectedItemId = "";
          }
          persistState();
          artifactEditor.setAttribute("aria-busy", "true");
          editorStatus.textContent = artifactId + " 불러오는 중…";
          vscode.postMessage({
            type: "artifact.select",
            artifactType,
            artifactId,
          });
        }

        function renderArtifactIndex() {
          artifactList.replaceChildren();
          const artifacts = artifactIndex?.artifacts || [];
          const labels = {
            intake: "Intake",
            specification: "Specification",
            "work-unit": "Work Unit",
          };
          let previousType;
          for (const artifact of artifacts) {
            if (artifact.artifactType !== previousType) {
              appendTextElement(
                artifactList,
                "strong",
                "artifact-type-heading",
                labels[artifact.artifactType] || artifact.artifactType,
              );
              previousType = artifact.artifactType;
            }
            artifactList.append(
              createTreeButton(
                artifact.title + " · " + artifact.id,
                state.selectedArtifactType === artifact.artifactType &&
                  state.selectedArtifactId === artifact.id,
                () => requestArtifact(artifact.artifactType, artifact.id),
              ),
            );
          }
          if (artifacts.length === 0) {
            appendTextElement(
              artifactList,
              "p",
              "kanban-column-empty",
              "지원되는 artifact 없음",
            );
          }
        }

        function selectedSection() {
          return artifactDocument?.sections.find(
            (section) => section.id === state.selectedSectionId,
          );
        }

        function selectedItem() {
          return selectedSection()?.items.find(
            (item) => item.id === state.selectedItemId,
          );
        }

        function selectSection(sectionId) {
          state.selectedSectionId = sectionId;
          const section = artifactDocument.sections.find(
            (candidate) => candidate.id === sectionId,
          );
          state.selectedItemId = section?.items[0]?.id || "";
          persistState();
          renderArtifactDocument();
        }

        function selectItem(itemId) {
          state.selectedItemId = itemId;
          persistState();
          renderArtifactDocument();
        }

        function fieldEditor(label, value, commit) {
          const wrapper = document.createElement("div");
          wrapper.className = "artifact-field";
          const fieldLabel = document.createElement("label");
          fieldLabel.textContent = label;
          let input;
          if (typeof value === "boolean") {
            input = document.createElement("input");
            input.type = "checkbox";
            input.checked = value;
            input.addEventListener("change", () => commit(input.checked));
          } else if (typeof value === "number") {
            input = document.createElement("input");
            input.type = "number";
            input.value = String(value);
            input.addEventListener("input", () => commit(Number(input.value)));
          } else {
            input = document.createElement("textarea");
            const stringList =
              Array.isArray(value) &&
              value.every((entry) => typeof entry === "string");
            input.value = stringList ? value.join("\\n") : String(value ?? "");
            input.addEventListener("input", () =>
              commit(stringList ? input.value.split("\\n") : input.value),
            );
          }
          wrapper.append(fieldLabel, input);
          return wrapper;
        }

        function renderStructuredFields() {
          editorFields.replaceChildren();
          const item = selectedItem();
          if (!item) {
            appendTextElement(
              editorFields,
              "p",
              "kanban-column-empty",
              "편집할 content item을 선택하세요.",
            );
            return;
          }
          let draft = structuredClone(item.content);
          const editable = [];
          const register = (label, value, commit) => {
            const supported =
              ["string", "number", "boolean"].includes(typeof value) ||
              (Array.isArray(value) &&
                value.every((entry) => typeof entry === "string"));
            if (supported) {
              editable.push(fieldEditor(label, value, commit));
            }
          };
          if (
            ["string", "number", "boolean"].includes(typeof draft) ||
            (Array.isArray(draft) &&
              draft.every((entry) => typeof entry === "string"))
          ) {
            register("content", draft, (value) => {
              draft = value;
            });
          } else if (draft && typeof draft === "object" && !Array.isArray(draft)) {
            for (const [key, value] of Object.entries(draft)) {
              register(key, value, (nextValue) => {
                draft[key] = nextValue;
              });
            }
          }
          editorFields.append(...editable);
          if (editable.length === 0) {
            appendTextElement(
              editorFields,
              "p",
              "kanban-column-empty",
              "이 item에는 현재 지원되는 scalar 또는 string-list field가 없습니다.",
            );
            return;
          }
          const saveRow = document.createElement("div");
          saveRow.className = "artifact-save-row";
          const saveButton = document.createElement("button");
          saveButton.className = "secondary-button";
          saveButton.type = "button";
          saveButton.textContent = "Manager로 저장";
          saveButton.addEventListener("click", () => {
            const requestId =
              "artifact-save-" + Date.now() + "-" + ++editorSaveSequence;
            artifactEditor.setAttribute("aria-busy", "true");
            editorStatus.textContent = item.id + " manager 검증 중…";
            vscode.postMessage({
              type: "artifact.saveItem",
              requestId,
              artifactType: artifactDocument.artifactType,
              artifactId: artifactDocument.id,
              sectionId: state.selectedSectionId,
              itemId: item.id,
              documentVersion: artifactDocument.documentVersion,
              content: draft,
            });
          });
          saveRow.append(saveButton);
          editorFields.append(saveRow);
        }

        function renderArtifactDocument() {
          sectionList.replaceChildren();
          itemList.replaceChildren();
          if (!artifactDocument) {
            editorPreview.textContent = "";
            renderStructuredFields();
            return;
          }
          const sections = artifactDocument.sections || [];
          if (
            !sections.some((section) => section.id === state.selectedSectionId)
          ) {
            state.selectedSectionId = sections[0]?.id || "";
          }
          for (const section of sections) {
            sectionList.append(
              createTreeButton(
                section.title,
                section.id === state.selectedSectionId,
                () => selectSection(section.id),
              ),
            );
          }
          const section = selectedSection();
          if (
            !section?.items.some((item) => item.id === state.selectedItemId)
          ) {
            state.selectedItemId = section?.items[0]?.id || "";
          }
          for (const item of section?.items || []) {
            itemList.append(
              createTreeButton(
                item.id + " · " + item.kind,
                item.id === state.selectedItemId,
                () => selectItem(item.id),
              ),
            );
          }
          editorPreview.textContent = JSON.stringify(
            artifactDocument.preview,
            null,
            2,
          );
          editorStatus.textContent =
            artifactDocument.title +
            " · " +
            artifactDocument.artifactType +
            " · " +
            artifactDocument.documentVersion;
          editorError.hidden = true;
          artifactEditor.setAttribute("aria-busy", "false");
          persistState();
          renderArtifactIndex();
          renderStructuredFields();
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
            for (const boardTab of kanbanBoardTabs) {
              boardTab.classList.remove("is-drop-target");
            }
          });

          return cardElement;
        }

        function renderKanban() {
          if (!snapshot) {
            return;
          }
          const selectedBoard = state.selectedKanbanBoard;
          for (const column of kanbanColumns) {
            column.hidden = column.dataset.kanbanColumn !== selectedBoard;
            const model = snapshot.columns.find(
              (candidate) => candidate.id === column.dataset.kanbanColumn,
            );
            const cards = model?.cards || [];
            const cardList = column.querySelector('[data-card-list]');
            const boardTab = kanbanBoardTabs.find(
              (candidate) =>
                candidate.dataset.kanbanBoardTarget === column.dataset.kanbanColumn,
            );
            boardTab.querySelector('[data-board-count]').textContent = String(cards.length);
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

        for (const [index, boardTab] of kanbanBoardTabs.entries()) {
          boardTab.addEventListener("click", () => {
            selectKanbanBoard(boardTab.dataset.kanbanBoardTarget);
          });

          boardTab.addEventListener("keydown", (event) => {
            let targetIndex;
            if (event.key === "ArrowLeft") {
              targetIndex =
                (index - 1 + kanbanBoardTabs.length) % kanbanBoardTabs.length;
            } else if (event.key === "ArrowRight") {
              targetIndex = (index + 1) % kanbanBoardTabs.length;
            } else if (event.key === "Home") {
              targetIndex = 0;
            } else if (event.key === "End") {
              targetIndex = kanbanBoardTabs.length - 1;
            } else {
              return;
            }
            event.preventDefault();
            selectKanbanBoard(
              kanbanBoardTabs[targetIndex].dataset.kanbanBoardTarget,
              { focus: true },
            );
          });

          boardTab.addEventListener("dragover", (event) => {
            const allowedTargets = dragState?.allowedTargets || new Set();
            if (allowedTargets.has(boardTab.dataset.kanbanBoardTarget)) {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              boardTab.classList.add("is-drop-target");
            }
          });
          boardTab.addEventListener("dragleave", () => {
            boardTab.classList.remove("is-drop-target");
          });
          boardTab.addEventListener("drop", (event) => {
            event.preventDefault();
            boardTab.classList.remove("is-drop-target");
            const allowedTargets = dragState?.allowedTargets || new Set();
            if (
              dragState &&
              allowedTargets.has(boardTab.dataset.kanbanBoardTarget)
            ) {
              requestTransition(dragState.card, boardTab.dataset.kanbanBoardTarget);
            }
          });
        }

        refreshButton.addEventListener("click", () => {
          kanbanWorkspace.setAttribute("aria-busy", "true");
          vscode.postMessage({ type: "kanban.refresh" });
        });
        editorRefresh.addEventListener("click", () => {
          artifactEditor.setAttribute("aria-busy", "true");
          editorStatus.textContent = "artifact 목록 갱신 중…";
          vscode.postMessage({ type: "artifact.refresh" });
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
              selectKanbanBoard(message.targetStatus);
            } else {
              notice.textContent = "상태 전이가 적용되지 않았습니다.";
              errors.hidden = false;
              errors.textContent =
                message.error?.message || "Work Unit manager가 전이를 거부했습니다.";
            }
            renderKanban();
          } else if (
            message.type === "artifact.index" &&
            message.index?.schemaVersion === "1.0.0"
          ) {
            artifactIndex = message.index;
            renderArtifactIndex();
            artifactEditor.setAttribute("aria-busy", "false");
            if (
              state.selectedArtifactType &&
              state.selectedArtifactId &&
              artifactIndex.artifacts.some(
                (artifact) =>
                  artifact.artifactType === state.selectedArtifactType &&
                  artifact.id === state.selectedArtifactId,
              )
            ) {
              requestArtifact(
                state.selectedArtifactType,
                state.selectedArtifactId,
                false,
              );
            } else {
              editorStatus.textContent =
                artifactIndex.artifacts.length +
                "개 artifact · 탐색할 항목을 선택하세요.";
            }
          } else if (
            message.type === "artifact.document" &&
            message.document?.schemaVersion === "1.0.0"
          ) {
            artifactDocument = message.document;
            state.selectedArtifactType = artifactDocument.artifactType;
            state.selectedArtifactId = artifactDocument.id;
            renderArtifactDocument();
          } else if (message.type === "artifact.savePending") {
            artifactEditor.setAttribute("aria-busy", "true");
            editorStatus.textContent = "manager 저장 및 full validation 중…";
          } else if (message.type === "artifact.saveResult") {
            artifactEditor.setAttribute("aria-busy", "false");
            if (message.ok) {
              editorStatus.textContent = "manager 저장 및 validation 완료";
              editorError.hidden = true;
              vscode.postMessage({ type: "artifact.refresh" });
            } else {
              editorStatus.textContent = "저장이 적용되지 않았습니다.";
              editorError.hidden = false;
              editorError.textContent =
                message.error?.message || "artifact manager가 저장을 거부했습니다.";
            }
          } else if (message.type === "artifact.error") {
            artifactEditor.setAttribute("aria-busy", "false");
            editorError.hidden = false;
            editorError.textContent =
              message.error?.message || "artifact를 불러오지 못했습니다.";
          }
        });

        activateTab(knownTabs.has(state.selectedTab) ? state.selectedTab : "dashboard");
        selectKanbanBoard(state.selectedKanbanBoard);
        vscode.postMessage({ type: "kanban.ready" });
        vscode.postMessage({ type: "artifact.ready" });
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
