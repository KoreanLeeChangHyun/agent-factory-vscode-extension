"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { TAB_DEFINITIONS, createWebviewHtml } = require("../../src/webviewShell");

test("shell defines the five approved tabs in order", () => {
  assert.deepEqual(
    TAB_DEFINITIONS.map(({ id, label }) => ({ id, label })),
    [
      { id: "dashboard", label: "Dashboard" },
      { id: "design", label: "Design" },
      { id: "kanban", label: "Kanban" },
      { id: "context", label: "Context" },
      { id: "view", label: "View" },
    ],
  );
});

test("shell renders an accessible tablist, selected header, and secure CSP", () => {
  const html = createWebviewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });

  assert.match(html, /role="tablist"/);
  assert.equal((html.match(/data-tab-id="/g) || []).length, 5);
  assert.equal((html.match(/data-panel-id="/g) || []).length, 5);
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
  assert.match(html, /setState\(\{ selectedTab: tabId \}\)/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /Home/);
  assert.match(html, /End/);
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
  assert.match(html, /\.workspace-tabs\s*\{[^}]*padding:\s*0;/s);
  assert.match(html, /\.workspace-tab\s*\{[^}]*flex:\s*1 1 0;/s);
  assert.match(html, /\.workspace-tab\s*\{[^}]*min-width:\s*0;/s);
  assert.match(html, /\.workspace-panel\s*\{[^}]*padding:\s*0;/s);
  assert.match(html, /\.empty-state\s*\{[^}]*width:\s*100%;/s);
  assert.match(html, /\.empty-state\s*\{[^}]*min-height:\s*100%;/s);
  assert.match(html, /\.empty-state\s*\{[^}]*margin:\s*0;/s);
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
