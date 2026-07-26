"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createChatViewHtml } = require("../../src/chatView");

function render() {
  return createChatViewHtml({
    cspSource: "vscode-webview://test",
    nonce: "test-nonce",
  });
}

test("Chat view renders accessible Main and Workflow tabs with SVG icons", () => {
  const html = render();

  assert.match(html, /role="tablist"[^>]+aria-label="Agent chat modes"/);
  assert.match(html, /data-mode="main"[^>]+aria-selected="true"/);
  assert.match(html, /data-mode="workflow"[^>]+aria-selected="false"/);
  assert.match(html, />Main Agent Sessions</);
  assert.match(html, />Workflow Session</);
  assert.ok((html.match(/<svg\b/g) || []).length >= 3);
  assert.doesNotMatch(html, /::before|::after|data:image\/svg|[›⌄▸▾▲▼←→]/);
});

test("Chat view keeps local sessions and per-session drafts in VS Code state", () => {
  const html = render();

  assert.match(html, /acquireVsCodeApi\(\)/);
  assert.match(html, /vscode\.getState\(\)/);
  assert.match(html, /vscode\.setState\(/);
  assert.match(html, /activeSessionId/);
  assert.match(html, /sessions/);
  assert.match(html, /draft/);
  assert.match(html, /data-new-session/);
  assert.match(html, /data-composer/);
  assert.match(html, /ArrowLeft/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /Home/);
  assert.match(html, /End/);
});

test("Chat view enforces CSP and exposes an allowlisted Extension Host boundary", () => {
  const html = render();

  assert.match(
    html,
    /default-src 'none'; style-src vscode-webview:\/\/test 'unsafe-inline'; script-src 'nonce-test-nonce';/,
  );
  assert.match(html, /<script nonce="test-nonce">/);
  assert.doesNotMatch(html, /\bfetch\s*\(|WebSocket|EventSource/);
  assert.match(html, /vscode\.postMessage\(/);
  assert.match(html, /type: "chat\.ready"/);
  assert.match(html, /type: "chat\.submit"/);
  assert.match(html, /type: "chat\.cancel"/);
  assert.match(html, /data-send/);
  assert.match(html, /aria-label="Send message"/);
  assert.match(html, /data-cancel/);
  assert.match(html, /data-messages/);
  assert.match(html, /data-session-status/);
  assert.match(html, /window\.addEventListener\("message"/);
  assert.match(html, /textContent/);
  assert.doesNotMatch(html, /\.innerHTML\s*=/);
});
