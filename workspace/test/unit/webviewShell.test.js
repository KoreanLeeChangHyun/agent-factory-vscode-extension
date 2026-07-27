"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { TAB_DEFINITIONS, createWebviewHtml } = require("../../src/webviewShell");

test("shell defines the four approved tabs in order", () => {
  assert.deepEqual(
    TAB_DEFINITIONS.map(({ id, label }) => ({ id, label })),
    [
      { id: "dashboard", label: "Dashboard" },
      { id: "editor", label: "Editor" },
      { id: "kanban", label: "Kanban" },
      { id: "context", label: "Context" },
    ],
  );
});

test("shell renders an accessible tablist, selected header, and secure CSP", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/data-tab-id="/g) || []).length, 4);
  assert.equal((html.match(/data-panel-id="/g) || []).length, 4);
  assert.match(html, /aria-selected="true"[^>]*>Dashboard</);
  assert.match(html, /data-selected-title>Dashboard</);
  assert.match(
    html,
    /default-src 'none'; style-src vscode-webview:\/\/test 'unsafe-inline'; script-src 'nonce-test-nonce';/,
  );
  assert.match(html, /<script nonce="test-nonce">/);
  assert.doesNotMatch(html, /retainContextWhenHidden/);
});

test("shell uses VS Code state APIs and keyboard tab navigation", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /getState\(\)/);
  assert.match(html, /vscode\.setState\(state\)/);
  assert.match(html, /state\.selectedTab = tabId/);
  assert.match(html, /\["design", "view"\]\.includes\(state\.selectedTab\)/);
  assert.match(html, /selectedKanbanBoard:\s*"backlog"/);
  assert.match(html, /state\.selectedKanbanBoard = boardId/);
  assert.match(html, /delete state\.kanbanFilter/);
  assert.doesNotMatch(html, /state\.kanbanFilter\s*=/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /Home/);
  assert.match(html, /End/);
});

test("Editor renders artifact navigation, structured fields, and read-only JSON", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /data-editor-artifacts/);
  assert.match(html, /data-editor-sections/);
  assert.match(html, /data-editor-items/);
  assert.match(html, /data-editor-fields/);
  assert.match(html, /data-editor-preview/);
  assert.match(html, /artifact\.ready/);
  assert.match(html, /type:\s*"artifact\.select"/);
  assert.match(html, /type:\s*"artifact\.saveItem"/);
  assert.match(html, /requestArtifact\(\s*state\.selectedArtifactType,\s*state\.selectedArtifactId,\s*false/);
  assert.match(html, /editorPreview\.textContent\s*=/);
  assert.doesNotMatch(html, /editorPreview\.innerHTML\s*=/);
});

test("Kanban renders header board selectors and only the selected board", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  for (const status of [
    "backlog",
    "ready",
    "working",
    "review",
    "done",
    "blocked",
  ]) {
    assert.match(html, new RegExp(`data-kanban-column="${status}"`));
    assert.match(html, new RegExp(`data-kanban-board-target="${status}"`));
  }
  assert.equal((html.match(/data-kanban-board-target="/g) || []).length, 6);
  assert.match(html, /data-kanban-board-selector/);
  assert.match(html, /data-board-count/);
  assert.match(html, /column\.hidden = column\.dataset\.kanbanColumn !== selectedBoard/);
  assert.doesNotMatch(html, /data-kanban-filter/);
  assert.doesNotMatch(html, /Work Unit 필터/);
  assert.doesNotMatch(html, /placeholder="제목 또는 id"/);
  assert.match(html, /draggable/);
  assert.match(html, /moveTarget\.dataset\.moveTarget/);
  assert.match(html, /moveButton\.dataset\.moveButton/);
  assert.match(html, /kanban\.ready/);
  assert.match(html, /kanban\.refresh/);
  assert.match(html, /type:\s*"kanban\.transition"/);
  assert.doesNotMatch(html, /kanban\.(?:create|edit)/);
});

test("Kanban drag and Move controls use the same capability and request contract", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /card\.capabilities\.filter\(\(capability\) => capability\.allowed\)/);
  assert.match(html, /allowedTargets\.has\(boardTab\.dataset\.kanbanBoardTarget\)/);
  assert.match(html, /requestTransition\(card,\s*moveTarget\.value\)/);
  assert.match(
    html,
    /requestTransition\(dragState\.card,\s*boardTab\.dataset\.kanbanBoardTarget\)/,
  );
  assert.match(html, /snapshotGeneratedAt:\s*snapshot\.generatedAt/);
  assert.match(html, /message\.type === "kanban\.transitionResult"/);
  assert.doesNotMatch(html, /showMovePreview/);
});

test("Kanban fills the remaining height with hidden independent scrollbars and no board gaps", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /\.kanban-board-selector\s*\{[^}]*overflow-x:\s*auto;/s);
  assert.match(html, /\.kanban-board-selector\s*\{[^}]*scrollbar-width:\s*none;/s);
  assert.match(html, /\.kanban-board-selector::?-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  assert.match(html, /\.kanban-workspace\s*\{[^}]*height:\s*calc\(100vh - 78px\);/s);
  assert.match(html, /\.kanban-workspace\s*\{[^}]*grid-template-rows:[^;]*minmax\(0,\s*1fr\);/s);
  assert.match(html, /\.kanban-board\s*\{[^}]*min-height:\s*0;/s);
  assert.match(html, /\.kanban-board\s*\{[^}]*gap:\s*0;/s);
  assert.match(html, /\.kanban-column\s*\{[^}]*height:\s*100%;/s);
  assert.match(html, /\.kanban-card-list\s*\{[^}]*overflow-y:\s*auto;/s);
  assert.match(html, /\.kanban-card-list\s*\{[^}]*scrollbar-width:\s*none;/s);
  assert.match(html, /\.kanban-card-list::?-webkit-scrollbar\s*\{[^}]*display:\s*none;/s);
  assert.doesNotMatch(html, /min-width:\s*1430px/);
  assert.doesNotMatch(html, /repeat\(6,\s*minmax\(230px,\s*1fr\)\)/);
});

test("shell fills the available width with equal theme-aware tabs and surfaces", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /--vscode-editorGroupHeader-tabsBackground/);
  assert.match(html, /--vscode-tab-inactiveBackground/);
  assert.match(html, /--vscode-tab-hoverBackground/);
  assert.match(html, /--vscode-tab-activeBorder/);
  assert.match(html, /body\s*\{[^}]*margin:\s*0;/s);
  assert.match(html, /body\s*\{[^}]*padding:\s*0;/s);
  assert.match(html, /\.workspace-tabs\s*\{[^}]*padding:\s*0;/s);
  assert.match(html, /\.workspace-tab\s*\{[^}]*flex:\s*1 1 0;/s);
  assert.match(html, /\.workspace-tab\s*\{[^}]*min-width:\s*0;/s);
  assert.match(html, /\.workspace-tab\s*\{[^}]*min-height:\s*40px;/s);
  assert.match(html, /\.workspace-panel\s*\{[^}]*padding:\s*0;/s);
  assert.match(html, /\.selected-header\s*\{[^}]*min-height:\s*32px;/s);
  assert.match(
    html,
    /\.selected-header\s*\{[^}]*padding:\s*0 clamp\(16px,\s*2\.5vw,\s*32px\);/s,
  );
  assert.match(html, /\.empty-state\s*\{[^}]*width:\s*100%;/s);
  assert.match(html, /\.empty-state\s*\{[^}]*min-height:\s*100%;/s);
  assert.match(html, /\.empty-state\s*\{[^}]*margin:\s*0;/s);
  assert.match(
    html,
    /\.empty-state\s*\{[^}]*padding:\s*clamp\(24px,\s*3vw,\s*36px\);/s,
  );
  assert.match(html, /\.selected-header\s*\{[^}]*--vscode-editor-background/s);
  assert.match(html, /\.empty-state\s*\{[^}]*--vscode-editor-background/s);
  assert.doesNotMatch(html, /--vscode-editorWidget-(?:background|border)/);
  assert.doesNotMatch(html, /width:\s*min\(100%,\s*720px\)/);
  assert.doesNotMatch(html, /margin-inline:\s*auto/);
  assert.doesNotMatch(
    html,
    /(?:color|background|border(?:-color)?):\s*(?:#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i,
  );
});
