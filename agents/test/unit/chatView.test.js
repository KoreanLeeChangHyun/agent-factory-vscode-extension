"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createChatViewHtml,
  groupMessagesIntoTurns,
  shouldSubmitComposerKey,
} = require("../../src/chatView");

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

test("Chat view aligns mode tabs and the session header with Workspace geometry", () => {
  const html = render();

  assert.match(html, /body\s*\{[^}]*margin:\s*0;[^}]*padding:\s*0;/s);
  assert.match(html, /\.mode-tabs\s*\{[^}]*padding:\s*0;/s);
  assert.match(html, /\.mode-tab\s*\{[^}]*position:\s*relative;/s);
  assert.match(html, /\.mode-tab\s*\{[^}]*min-height:\s*34px;/s);
  assert.match(
    html,
    /\.mode-tab-indicator\s*\{[^}]*right:\s*8px;[^}]*bottom:\s*0;[^}]*left:\s*8px;[^}]*height:\s*2px;/s,
  );
  assert.match(html, /class="mode-tab-indicator" aria-hidden="true"/);
  assert.match(html, /\.session-header\s*\{[^}]*min-height:\s*44px;/s);
  assert.match(html, /\.mode-panel\s*\{[^}]*padding:\s*0;/s);
});

test("Chat view renders one Web-aligned composer card with a transparent input and bottom action", () => {
  const html = render();

  assert.match(html, /\.composer-region\s*\{[^}]*padding:\s*8px 0 0;/s);
  assert.match(
    html,
    /\.composer-card\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*72px;[^}]*padding:\s*12px;[^}]*border:\s*1px solid/s,
  );
  assert.match(
    html,
    /\.composer\s*\{[^}]*max-height:\s*144px;[^}]*padding:\s*0 44px 32px 0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
  );
  assert.match(
    html,
    /\.composer-action\s*\{[^}]*position:\s*absolute;[^}]*right:\s*12px;[^}]*bottom:\s*12px;[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
  );
  assert.match(
    html,
    /class="composer-card"[\s\S]*data-composer[\s\S]*data-send[\s\S]*data-cancel[\s\S]*<\/div>\s*<div class="session-status"/,
  );
  assert.match(html, /sendButton\.hidden = running/);
  assert.match(html, /cancelButton\.hidden = !running/);
  assert.doesNotMatch(html, /--af-color-|frontend\/src|agent-factory\/web/);
});

test("Chat view groups messages into turns with user cards and transparent assistant output", () => {
  const messages = [
    { role: "assistant", text: "opening" },
    { role: "user", text: "one" },
    { role: "assistant", text: "two" },
    { role: "assistant", text: "follow-up" },
    { role: "user", text: "three" },
    { role: "assistant", text: "four" },
  ];

  assert.deepEqual(
    groupMessagesIntoTurns(messages).map((turn) =>
      turn.map((message) => message.text),
    ),
    [["opening"], ["one", "two"], ["follow-up"], ["three", "four"]],
  );

  const html = render();
  assert.match(html, /turn\.className = "message-turn"/);
  assert.match(html, /element\.className = "message message-" \+ item\.role/);
  assert.match(
    html,
    /\.message-user\s*\{[^}]*padding:\s*7px 9px;[^}]*border:\s*1px solid[^}]*background:/s,
  );
  assert.match(
    html,
    /\.message-assistant\s*\{[^}]*padding:\s*7px 0;[^}]*border:\s*0;[^}]*background:\s*transparent;/s,
  );
});

test("Chat composer submits Enter and existing shortcuts while preserving Shift+Enter and IME composition", () => {
  assert.equal(shouldSubmitComposerKey({ key: "Enter" }), true);
  assert.equal(
    shouldSubmitComposerKey({ key: "Enter", ctrlKey: true }),
    true,
  );
  assert.equal(
    shouldSubmitComposerKey({ key: "Enter", metaKey: true }),
    true,
  );
  assert.equal(
    shouldSubmitComposerKey({ key: "Enter", shiftKey: true }),
    false,
  );
  assert.equal(
    shouldSubmitComposerKey({ key: "Enter", isComposing: true }),
    false,
  );
  assert.equal(shouldSubmitComposerKey({ key: "a" }), false);

  const html = render();
  assert.match(html, /if \(!shouldSubmitComposerKey\(event\)\) return;/);
  assert.match(html, /event\.preventDefault\(\);\s*submit\(\);/s);
});
