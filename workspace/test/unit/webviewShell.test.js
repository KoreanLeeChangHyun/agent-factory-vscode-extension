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
