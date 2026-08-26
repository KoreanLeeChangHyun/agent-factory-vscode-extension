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

const KANBAN_CLOSED_COLUMNS_STORAGE_KEY =
  "agentFactory.workspace.kanban.closedColumns";

function normalizeClosedKanbanColumns(value, validColumnIds) {
  if (!Array.isArray(value)) {
    return [];
  }
  const validIds = new Set(validColumnIds);
  return Array.from(
    new Set(value.filter((columnId) => validIds.has(columnId))),
  );
}

function loadClosedKanbanColumns(
  windowObject,
  storageKey,
  validColumnIds,
  fallback = [],
) {
  const normalizedFallback = normalizeClosedKanbanColumns(
    fallback,
    validColumnIds,
  );
  try {
    const stored = windowObject.localStorage.getItem(storageKey);
    if (stored === null) {
      return normalizedFallback;
    }
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed)
      ? normalizeClosedKanbanColumns(parsed, validColumnIds)
      : normalizedFallback;
  } catch {
    return normalizedFallback;
  }
}

function storeClosedKanbanColumns(
  windowObject,
  storageKey,
  validColumnIds,
  value,
) {
  try {
    windowObject.localStorage.setItem(
      storageKey,
      JSON.stringify(normalizeClosedKanbanColumns(value, validColumnIds)),
    );
    return true;
  } catch {
    return false;
  }
}

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
      <section
        class="kanban-column"
        id="kanban-column-${id}"
        data-kanban-column="${id}"
      >
        <header class="kanban-column-header">
          <div class="kanban-column-heading">
            <span class="kanban-column-label">${label}</span>
            <span class="kanban-count" data-column-count aria-label="${label} 항목 수">0</span>
          </div>
        </header>
        <div class="kanban-card-list" id="kanban-card-list-${id}" data-card-list>
          <p class="kanban-column-empty">항목 없음</p>
        </div>
      </section>`,
  ).join("");

  const kanbanPicklistOptions = KANBAN_COLUMNS.map(
    ({ id, label }) => `
      <label class="kanban-picklist-option">
        <input
          type="checkbox"
          checked
          data-kanban-column-option="${id}"
        >
        <span>${label}</span>
      </label>`,
  ).join("");

  const panels = TAB_DEFINITIONS.map((definition, index) => {
    const { id, label, description } = definition;
    let content;
    if (id === "kanban") {
      content = `
        <div class="kanban-workspace" aria-busy="true">
          <div class="kanban-errors" data-kanban-errors role="alert" hidden></div>
          <div class="kanban-board" id="kanban-board" aria-label="Work Unit lifecycle board">
            ${kanbanColumns}
          </div>
        </div>`;
    } else if (id === "editor") {
      content = `
        <div class="artifact-editor" aria-busy="true">
          <aside class="artifact-browser" aria-label="Artifact browser">
            <div class="artifact-list" data-editor-artifacts></div>
            <div class="section-list" data-editor-sections></div>
            <div class="item-list" data-editor-items></div>
          </aside>
          <section class="artifact-detail" aria-label="Artifact editor">
            <div class="artifact-editor-error" data-editor-error role="alert" hidden></div>
            <div class="artifact-fields" data-editor-fields></div>
            <div class="artifact-preview-shell" data-editor-preview-shell hidden>
              <article class="artifact-document" data-editor-preview tabindex="0"></article>
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
        height: 100vh;
        min-height: 0;
        grid-template-rows: auto auto minmax(0, 1fr);
        overflow: hidden;
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
        height: 40px;
        min-width: 0;
        min-height: 40px;
        padding: 6px 12px 8px;
        overflow: hidden;
        border: 0;
        color: var(--vscode-tab-inactiveForeground);
        background: var(--vscode-tab-inactiveBackground, transparent);
        cursor: pointer;
        text-overflow: ellipsis;
        white-space: nowrap;
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
        min-height: 32px;
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

      .editor-header-tools {
        display: flex;
        min-width: 0;
        align-items: center;
        gap: 8px;
        margin-left: auto;
      }

      .editor-header-toggle {
        margin-left: -8px;
      }

      .editor-header-tools[hidden] {
        display: none;
      }

      .editor-header-status {
        min-width: 0;
        overflow: hidden;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .selected-header.is-kanban-header {
        padding: 0;
      }

      .kanban-picklist {
        position: relative;
        flex: 0 0 auto;
        align-self: stretch;
        margin-left: auto;
      }

      .kanban-picklist summary {
        display: flex;
        min-height: 32px;
        align-items: center;
        padding: 0 8px;
        list-style: none;
        border: 0;
        border-left: 1px solid var(--vscode-panel-border);
        color: var(--vscode-foreground);
        background: transparent;
        cursor: pointer;
        white-space: nowrap;
      }

      .kanban-picklist summary::-webkit-details-marker {
        display: none;
      }

      .kanban-picklist summary:hover {
        background: var(--vscode-list-hoverBackground);
      }

      .kanban-picklist-options {
        position: absolute;
        z-index: 10;
        top: 100%;
        right: 0;
        display: grid;
        min-width: 160px;
        padding: 4px 0;
        border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
        background: var(--vscode-menu-background, var(--vscode-editor-background));
        box-shadow: 0 2px 8px var(--vscode-widget-shadow);
      }

      .kanban-picklist-option {
        display: flex;
        min-height: 28px;
        align-items: center;
        gap: 8px;
        padding: 4px 10px;
        color: var(--vscode-menu-foreground, var(--vscode-foreground));
        cursor: pointer;
      }

      .kanban-picklist-option:hover {
        background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      }

      .workspace-body {
        min-height: 0;
        overflow: auto;
        background: var(--vscode-editor-background);
      }

      .workspace-body.is-kanban-active {
        overflow: hidden;
      }

      .workspace-body.is-editor-active {
        overflow: hidden;
      }

      .workspace-panel {
        min-height: 100%;
        padding: 0;
      }

      .workspace-body.is-kanban-active .workspace-panel {
        height: 100%;
        min-height: 0;
      }

      .workspace-body.is-editor-active .workspace-panel {
        height: 100%;
        min-height: 0;
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
        height: 100%;
        min-height: 0;
        grid-template-columns: minmax(220px, 28%) minmax(0, 1fr);
      }

      .artifact-editor.is-browser-collapsed {
        grid-template-columns: 0 minmax(0, 1fr);
      }

      .artifact-browser {
        min-width: 0;
        min-height: 0;
        padding: 12px;
        overflow: auto;
        border-right: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
        scrollbar-width: none;
      }

      .artifact-browser::-webkit-scrollbar {
        display: none;
      }

      .artifact-browser-toggle {
        flex: 0 0 auto;
        width: 26px;
        height: 26px;
        padding: 0;
        border: 0;
        color: var(--vscode-foreground);
        background: transparent;
        font: inherit;
        font-size: 20px;
        line-height: 1;
        cursor: pointer;
      }

      .artifact-browser-toggle:hover {
        background: var(--vscode-toolbar-hoverBackground);
      }

      .editor-list-icon,
      .editor-refresh-icon {
        width: 16px;
        height: 16px;
        fill: none;
        stroke: currentColor;
        stroke-linecap: round;
        stroke-linejoin: round;
        stroke-width: 1.5;
      }

      .editor-header-toggle[aria-expanded="true"] {
        background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground));
      }

      .artifact-editor.is-browser-collapsed .artifact-browser {
        padding: 0;
        overflow: hidden;
        border-right: 0;
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
        min-height: 0;
        padding: 16px;
        overflow: auto;
      }

      .artifact-editor-error {
        min-height: 22px;
        margin-bottom: 10px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .artifact-mode-switch {
        display: flex;
        flex: 0 0 auto;
        border: 1px solid var(--vscode-panel-border);
      }

      .artifact-mode-switch button {
        min-height: 26px;
        padding: 3px 10px;
        border: 0;
        color: var(--vscode-foreground);
        background: transparent;
        cursor: pointer;
      }

      .artifact-mode-switch button + button {
        border-left: 1px solid var(--vscode-panel-border);
      }

      .artifact-mode-switch button[aria-pressed="true"] {
        color: var(--vscode-button-foreground);
        background: var(--vscode-button-background);
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

      .artifact-fields[hidden] {
        display: none;
      }

      .artifact-field {
        display: grid;
        gap: 4px;
      }

      .artifact-field label {
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
        min-width: 0;
      }

      .artifact-document {
        box-sizing: border-box;
        width: min(100%, 960px);
        min-height: 220px;
        margin: 10px auto 32px;
        padding: clamp(24px, 4vw, 48px);
        border: 1px solid var(--vscode-panel-border);
        color: var(--vscode-editor-foreground);
        background: var(--vscode-editor-background);
        box-shadow: 0 3px 14px rgba(0, 0, 0, 0.2);
        line-height: 1.65;
      }

      .artifact-document-header {
        margin-bottom: 36px;
        padding-bottom: 20px;
        border-bottom: 2px solid var(--vscode-panel-border);
      }

      .artifact-document-type,
      .artifact-item-kind,
      .artifact-document-meta {
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
      }

      .artifact-document-type,
      .artifact-item-kind {
        font-weight: 600;
        letter-spacing: 0.06em;
        text-transform: uppercase;
      }

      .artifact-document-title {
        margin: 8px 0 10px;
        font-size: clamp(26px, 4vw, 36px);
        line-height: 1.2;
      }

      .artifact-document-section + .artifact-document-section {
        margin-top: 34px;
      }

      .artifact-document-section > h2 {
        margin: 0 0 16px;
        padding-bottom: 7px;
        border-bottom: 1px solid var(--vscode-panel-border);
        font-size: 20px;
      }

      .artifact-document-item + .artifact-document-item {
        margin-top: 22px;
      }

      .artifact-item-kind {
        margin-bottom: 4px;
      }

      .artifact-document-item h3 {
        margin: 0 0 8px;
        font-size: 14px;
        overflow-wrap: anywhere;
      }

      .artifact-value {
        overflow-wrap: anywhere;
      }

      .artifact-value p {
        margin: 0 0 9px;
        white-space: pre-wrap;
      }

      .artifact-value ul {
        margin: 6px 0 12px;
        padding-left: 24px;
      }

      .artifact-value li + li {
        margin-top: 4px;
      }

      .artifact-property {
        margin: 9px 0 0;
        padding-left: 14px;
        border-left: 2px solid var(--vscode-panel-border);
      }

      .artifact-property-label {
        display: block;
        margin-bottom: 3px;
        color: var(--vscode-descriptionForeground);
        font-size: 12px;
        font-weight: 600;
      }

      .artifact-value a {
        color: var(--vscode-textLink-foreground);
      }

      .artifact-empty-value {
        color: var(--vscode-descriptionForeground);
        font-style: italic;
      }

      @media (max-width: 720px) {
        .artifact-editor {
          grid-template-columns: 1fr;
          grid-template-rows: minmax(0, 42%) minmax(0, 1fr);
        }

        .artifact-editor.is-browser-collapsed {
          grid-template-columns: 1fr;
          grid-template-rows: 0 minmax(0, 1fr);
        }

        .artifact-browser {
          max-height: 42vh;
          border-right: 0;
          border-bottom: 1px solid var(--vscode-panel-border);
        }

        .artifact-document {
          padding: 24px 20px;
          box-shadow: none;
        }
      }

      .kanban-workspace {
        display: grid;
        height: 100%;
        min-height: 0;
        grid-template-rows: auto minmax(0, 1fr);
        padding: 0;
        overflow: hidden;
      }

      .kanban-picklist summary:focus-visible,
      .kanban-picklist-option input:focus-visible,
      .artifact-browser-toggle:focus-visible,
      .artifact-mode-switch button:focus-visible,
      .secondary-button:focus-visible {
        outline: 1px solid var(--vscode-focusBorder);
        outline-offset: 1px;
      }

      .secondary-button {
        min-height: 28px;
        padding: 4px 10px;
        border: 1px solid var(--vscode-button-border, transparent);
        color: var(--vscode-button-secondaryForeground);
        background: var(--vscode-button-secondaryBackground);
        cursor: pointer;
      }

      .secondary-button:hover {
        background: var(--vscode-button-secondaryHoverBackground);
      }

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
        display: flex;
        gap: 0;
        min-width: 0;
        min-height: 0;
        overflow: hidden;
      }

      .kanban-column {
        display: grid;
        flex: 1 1 0;
        height: 100%;
        min-width: 0;
        min-height: 0;
        grid-template-rows: auto minmax(0, 1fr);
        border: 1px solid var(--vscode-panel-border);
        background: var(--vscode-sideBar-background);
      }

      .kanban-column-header {
        min-width: 0;
        border-bottom: 1px solid var(--vscode-panel-border);
      }

      .kanban-column-heading {
        display: flex;
        width: 100%;
        min-width: 0;
        min-height: 38px;
        align-items: center;
        gap: 6px;
        padding: 7px 8px;
        overflow: hidden;
        color: var(--vscode-foreground);
      }

      .kanban-column-label {
        min-width: 0;
        overflow: hidden;
        font-size: 12px;
        font-weight: 600;
        text-overflow: ellipsis;
        text-transform: uppercase;
        white-space: nowrap;
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
        padding: 10px;
        border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border));
        color: var(--vscode-foreground);
        background: var(--vscode-editor-background);
      }

      .kanban-card-title {
        margin: 0;
        overflow-wrap: anywhere;
        font-size: 13px;
        line-height: 1.35;
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
        <button
          class="artifact-browser-toggle editor-header-toggle"
          type="button"
          data-editor-browser-toggle
          aria-expanded="true"
          aria-label="Artifacts 사이드바 접기"
          title="Artifacts 사이드바 접기"
          hidden
        >
          <svg class="editor-list-icon" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 4h1M6 4h7.5M2.5 8h1M6 8h7.5M2.5 12h1M6 12h7.5" />
          </svg>
        </button>
        <h1 data-selected-title>Dashboard</h1>
        <div
          class="editor-header-status"
          data-editor-status
          role="status"
          aria-live="polite"
          hidden
        >artifact를 선택하세요.</div>
        <div class="editor-header-tools" data-editor-header-tools hidden>
          <button
            class="artifact-browser-toggle"
            type="button"
            data-editor-refresh
            aria-label="Artifacts 새로 고침"
            title="Artifacts 새로 고침"
          >
            <svg class="editor-refresh-icon" viewBox="0 0 16 16" aria-hidden="true">
              <path d="M13.25 5.75A5.75 5.75 0 1 0 13.5 9" />
              <path d="M10.5 3.5h3v3" />
            </svg>
          </button>
          <div class="artifact-mode-switch" role="group" aria-label="Artifact mode">
            <button type="button" data-editor-mode="view" aria-pressed="true">View</button>
            <button type="button" data-editor-mode="edit" aria-pressed="false">Edit</button>
          </div>
        </div>
        <details class="kanban-picklist" data-kanban-picklist hidden>
          <summary>칸반 표시</summary>
          <div class="kanban-picklist-options" role="group" aria-label="표시할 칸반 선택">
            ${kanbanPicklistOptions}
          </div>
        </details>
      </header>
      <div class="workspace-body" data-workspace-body>
        ${panels}
      </div>
    </main>
    <script nonce="${nonce}">
      (() => {
        const KANBAN_CLOSED_COLUMNS_STORAGE_KEY = ${JSON.stringify(KANBAN_CLOSED_COLUMNS_STORAGE_KEY)};
        ${normalizeClosedKanbanColumns.toString()}
        ${loadClosedKanbanColumns.toString()}
        ${storeClosedKanbanColumns.toString()}
        const vscode = acquireVsCodeApi();
        const tabs = Array.from(document.querySelectorAll('[data-tab-id]'));
        const panels = Array.from(document.querySelectorAll('[data-panel-id]'));
        const selectedHeader = document.querySelector('.selected-header');
        const selectedTitle = document.querySelector('[data-selected-title]');
        const editorHeaderTools = document.querySelector('[data-editor-header-tools]');
        const kanbanPicklist = document.querySelector('[data-kanban-picklist]');
        const kanbanColumnOptions = Array.from(
          document.querySelectorAll('[data-kanban-column-option]'),
        );
        const workspaceBody = document.querySelector('[data-workspace-body]');
        const errors = document.querySelector('[data-kanban-errors]');
        const kanbanWorkspace = document.querySelector('.kanban-workspace');
        const kanbanColumns = Array.from(document.querySelectorAll('[data-kanban-column]'));
        const kanbanColumnsById = new Map(
          kanbanColumns.map((column) => [column.dataset.kanbanColumn, column]),
        );
        const kanbanOptionsById = new Map(
          kanbanColumnOptions.map((option) => [
            option.dataset.kanbanColumnOption,
            option,
          ]),
        );
        const artifactList = document.querySelector('[data-editor-artifacts]');
        const sectionList = document.querySelector('[data-editor-sections]');
        const itemList = document.querySelector('[data-editor-items]');
        const editorFields = document.querySelector('[data-editor-fields]');
        const editorPreviewShell = document.querySelector('[data-editor-preview-shell]');
        const editorPreview = document.querySelector('[data-editor-preview]');
        const editorStatus = document.querySelector('[data-editor-status]');
        const editorError = document.querySelector('[data-editor-error]');
        const editorRefresh = document.querySelector('[data-editor-refresh]');
        const editorBrowserToggle = document.querySelector('[data-editor-browser-toggle]');
        const editorModeButtons = Array.from(
          document.querySelectorAll('[data-editor-mode]'),
        );
        const artifactEditor = document.querySelector('.artifact-editor');
        const previousState = vscode.getState() || {};
        const kanbanColumnIds = Array.from(kanbanColumnsById.keys());
        const closedKanbanColumns = loadClosedKanbanColumns(
          window,
          KANBAN_CLOSED_COLUMNS_STORAGE_KEY,
          kanbanColumnIds,
          previousState.closedKanbanColumns,
        );
        const state = {
          selectedTab: "dashboard",
          selectedArtifactType: "",
          selectedArtifactId: "",
          selectedSectionId: "",
          selectedItemId: "",
          artifactBrowserCollapsed: false,
          artifactEditorMode: "view",
          ...previousState,
          closedKanbanColumns,
        };
        delete state.kanbanFilter;
        if (["design", "view"].includes(state.selectedTab)) {
          state.selectedTab = "editor";
        }
        if (!new Set(["view", "edit"]).has(state.artifactEditorMode)) {
          state.artifactEditorMode = "view";
        }
        const knownTabs = new Set(tabs.map((tab) => tab.dataset.tabId));
        let snapshot;
        let artifactIndex;
        let artifactDocument;
        let editorSaveSequence = 0;

        function persistState() {
          vscode.setState(state);
        }

        function setArtifactBrowserCollapsed(collapsed) {
          state.artifactBrowserCollapsed = Boolean(collapsed);
          artifactEditor.classList.toggle(
            "is-browser-collapsed",
            state.artifactBrowserCollapsed,
          );
          editorBrowserToggle.setAttribute(
            "aria-expanded",
            String(!state.artifactBrowserCollapsed),
          );
          const label = state.artifactBrowserCollapsed
            ? "Artifacts 사이드바 펼치기"
            : "Artifacts 사이드바 접기";
          editorBrowserToggle.setAttribute("aria-label", label);
          editorBrowserToggle.title = label;
          persistState();
        }

        function setArtifactEditorMode(mode) {
          state.artifactEditorMode = mode === "edit" ? "edit" : "view";
          editorFields.hidden = state.artifactEditorMode !== "edit";
          for (const button of editorModeButtons) {
            button.setAttribute(
              "aria-pressed",
              String(button.dataset.editorMode === state.artifactEditorMode),
            );
          }
          persistState();
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
          selectedTitle.hidden = tabId === "editor" || tabId === "kanban";
          editorBrowserToggle.hidden = tabId !== "editor";
          editorStatus.hidden = tabId !== "editor";
          editorHeaderTools.hidden = tabId !== "editor";
          kanbanPicklist.hidden = tabId !== "kanban";
          if (tabId !== "kanban") {
            kanbanPicklist.open = false;
          }
          selectedHeader.classList.toggle("is-kanban-header", tabId === "kanban");
          workspaceBody.classList.toggle("is-kanban-active", tabId === "kanban");
          workspaceBody.classList.toggle("is-editor-active", tabId === "editor");
          state.selectedTab = tabId;
          persistState();
        }

        function setKanbanColumnOpen(columnId, open, options = {}) {
          const column = kanbanColumnsById.get(columnId);
          const option = kanbanOptionsById.get(columnId);
          if (!column || !option) {
            return;
          }

          column.hidden = !open;
          option.checked = open;

          const closedColumns = new Set(state.closedKanbanColumns);
          if (open) {
            closedColumns.delete(columnId);
          } else {
            closedColumns.add(columnId);
          }
          state.closedKanbanColumns = Array.from(closedColumns);
          if (options.persist !== false) {
            persistState();
            storeClosedKanbanColumns(
              window,
              KANBAN_CLOSED_COLUMNS_STORAGE_KEY,
              kanbanColumnIds,
              state.closedKanbanColumns,
            );
          }
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

        function humanizeArtifactLabel(value) {
          return String(value || "")
            .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
            .replace(/[-_]+/g, " ")
            .replace(/^./, (character) => character.toUpperCase());
        }

        function appendDocumentValue(parent, value, depth = 0) {
          const wrapper = document.createElement("div");
          wrapper.className = "artifact-value";
          parent.append(wrapper);

          if (value === null || value === undefined || value === "") {
            const empty = document.createElement("span");
            empty.className = "artifact-empty-value";
            empty.textContent = "내용 없음";
            wrapper.append(empty);
            return;
          }

          if (["string", "number", "boolean"].includes(typeof value)) {
            const paragraph = document.createElement("p");
            if (
              typeof value === "string" &&
              /^https?:\\/\\//i.test(value)
            ) {
              const link = document.createElement("a");
              link.href = value;
              link.textContent = value;
              paragraph.append(link);
            } else {
              paragraph.textContent = String(value);
            }
            wrapper.append(paragraph);
            return;
          }

          if (Array.isArray(value)) {
            if (value.length === 0) {
              const empty = document.createElement("span");
              empty.className = "artifact-empty-value";
              empty.textContent = "항목 없음";
              wrapper.append(empty);
              return;
            }
            const list = document.createElement("ul");
            for (const entry of value) {
              const listItem = document.createElement("li");
              if (
                entry !== null &&
                typeof entry === "object"
              ) {
                appendDocumentValue(listItem, entry, depth + 1);
              } else {
                listItem.textContent = String(entry);
              }
              list.append(listItem);
            }
            wrapper.append(list);
            return;
          }

          if (typeof value === "object") {
            for (const [key, entry] of Object.entries(value)) {
              const property = document.createElement("div");
              property.className = "artifact-property";
              const label = document.createElement("span");
              label.className = "artifact-property-label";
              label.textContent = humanizeArtifactLabel(key);
              property.append(label);
              if (depth >= 5) {
                const fallback = document.createElement("p");
                fallback.textContent = JSON.stringify(entry);
                property.append(fallback);
              } else {
                appendDocumentValue(property, entry, depth + 1);
              }
              wrapper.append(property);
            }
          }
        }

        function renderDocumentPreview() {
          editorPreview.replaceChildren();
          editorPreviewShell.hidden = !artifactDocument;
          if (!artifactDocument) {
            return;
          }

          const typeLabels = {
            intake: "Intake",
            specification: "Specification",
            "work-unit": "Work Unit",
          };
          const header = document.createElement("header");
          header.className = "artifact-document-header";
          const type = document.createElement("div");
          type.className = "artifact-document-type";
          const typeLabel = typeLabels[artifactDocument.artifactType] ||
            humanizeArtifactLabel(artifactDocument.artifactType);
          type.textContent = typeLabel;
          const title = document.createElement("h1");
          title.className = "artifact-document-title";
          const artifactTitle = String(artifactDocument.title || "");
          const duplicateTypeSuffix = " " + typeLabel;
          title.textContent = artifactTitle.toLocaleLowerCase().endsWith(
            duplicateTypeSuffix.toLocaleLowerCase(),
          )
            ? artifactTitle.slice(0, -duplicateTypeSuffix.length)
            : artifactTitle;
          const meta = document.createElement("div");
          meta.className = "artifact-document-meta";
          meta.textContent = [
            artifactDocument.status,
            "Version " + artifactDocument.documentVersion,
          ].filter(Boolean).join(" · ");
          header.append(type, title, meta);
          editorPreview.append(header);

          for (const section of artifactDocument.sections || []) {
            const sectionElement = document.createElement("section");
            sectionElement.className = "artifact-document-section";
            const sectionTitle = document.createElement("h2");
            sectionTitle.textContent = section.title;
            sectionElement.append(sectionTitle);
            for (const item of section.items || []) {
              const itemElement = document.createElement("section");
              itemElement.className = "artifact-document-item";
              const kind = document.createElement("div");
              kind.className = "artifact-item-kind";
              kind.textContent = humanizeArtifactLabel(item.kind);
              const itemTitle = document.createElement("h3");
              itemTitle.textContent = item.id;
              itemElement.append(kind, itemTitle);
              appendDocumentValue(itemElement, item.content);
              sectionElement.append(itemElement);
            }
            editorPreview.append(sectionElement);
          }
        }

        function renderArtifactDocument() {
          sectionList.replaceChildren();
          itemList.replaceChildren();
          if (!artifactDocument) {
            editorPreview.replaceChildren();
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
          renderDocumentPreview();
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

        function createCard(card) {
          const cardElement = document.createElement("article");
          cardElement.className = "kanban-card";
          appendTextElement(cardElement, "h4", "kanban-card-title", card.title);
          return cardElement;
        }

        function renderKanban() {
          if (!snapshot) {
            return;
          }
          for (const column of kanbanColumns) {
            const model = snapshot.columns.find(
              (candidate) => candidate.id === column.dataset.kanbanColumn,
            );
            const cards = model?.cards || [];
            const cardList = column.querySelector('[data-card-list]');
            column.querySelector('[data-column-count]').textContent = String(cards.length);
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

        for (const option of kanbanColumnOptions) {
          option.addEventListener("change", () => {
            setKanbanColumnOpen(option.dataset.kanbanColumnOption, option.checked);
          });
        }

        editorRefresh.addEventListener("click", () => {
          artifactEditor.setAttribute("aria-busy", "true");
          editorStatus.textContent = "artifact 목록 갱신 중…";
          vscode.postMessage({ type: "artifact.refresh" });
        });
        editorBrowserToggle.addEventListener("click", () => {
          setArtifactBrowserCollapsed(!state.artifactBrowserCollapsed);
        });
        for (const button of editorModeButtons) {
          button.addEventListener("click", () => {
            setArtifactEditorMode(button.dataset.editorMode);
          });
        }
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
            renderKanban();
          } else if (message.type === "kanban.error") {
            kanbanWorkspace.setAttribute("aria-busy", "false");
            errors.hidden = false;
            errors.textContent = message.error?.message || "Kanban을 불러오지 못했습니다.";
          } else if (message.type === "kanban.transitionPending") {
            kanbanWorkspace.setAttribute("aria-busy", "true");
            renderKanban();
          } else if (message.type === "kanban.transitionResult") {
            kanbanWorkspace.setAttribute("aria-busy", "false");
            if (message.ok) {
              errors.hidden = true;
            } else {
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

        state.closedKanbanColumns = state.closedKanbanColumns.filter((columnId) =>
          kanbanColumnsById.has(columnId),
        );
        for (const column of kanbanColumns) {
          setKanbanColumnOpen(
            column.dataset.kanbanColumn,
            !state.closedKanbanColumns.includes(column.dataset.kanbanColumn),
            { persist: false },
          );
        }
        activateTab(knownTabs.has(state.selectedTab) ? state.selectedTab : "dashboard");
        setArtifactBrowserCollapsed(state.artifactBrowserCollapsed);
        setArtifactEditorMode(state.artifactEditorMode);
        vscode.postMessage({ type: "kanban.ready" });
        vscode.postMessage({ type: "artifact.ready" });
      })();
    </script>
  </body>
</html>`;
}

module.exports = {
  KANBAN_CLOSED_COLUMNS_STORAGE_KEY,
  KANBAN_COLUMNS,
  TAB_DEFINITIONS,
  createWebviewHtml,
  loadClosedKanbanColumns,
  storeClosedKanbanColumns,
};
