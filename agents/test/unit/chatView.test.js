"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createChatViewHtml,
  groupMessagesIntoTurns,
  resizeComposerInput,
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
  assert.match(html, /function createSvgIcon\(/);
  assert.match(html, /icon\.classList\.add\("session-tab-icon"\)/);
  assert.doesNotMatch(html, /textContent = "[▣×]"/);
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
  assert.match(html, /\.mode-tab\s*\{[^}]*min-height:\s*40px;/s);
  assert.match(
    html,
    /\.mode-tab-indicator\s*\{[^}]*right:\s*8px;[^}]*bottom:\s*0;[^}]*left:\s*8px;[^}]*height:\s*2px;/s,
  );
  assert.match(html, /class="mode-tab-indicator" aria-hidden="true"/);
  assert.match(html, /\.session-header\s*\{[^}]*min-height:\s*32px;/s);
  assert.match(html, /\.mode-panel\s*\{[^}]*padding:\s*0;/s);
});

test("Chat view renders one Web-aligned composer card with a transparent input and bottom action", () => {
  const html = render();

  assert.match(html, /\.composer-region\s*\{[^}]*padding:\s*8px 10px 6px;/s);
  assert.match(
    html,
    /\.composer-card\s*\{[^}]*position:\s*relative;[^}]*min-height:\s*88px;[^}]*padding:\s*12px 12px 40px;[^}]*border:\s*1px solid/s,
  );
  assert.match(
    html,
    /\.composer\s*\{[^}]*height:\s*20px;[^}]*max-height:\s*144px;[^}]*padding:\s*0;[^}]*border:\s*0;[^}]*resize:\s*none;[^}]*background:\s*transparent;/s,
  );
  assert.match(
    html,
    /\.composer-action\s*\{[^}]*position:\s*absolute;[^}]*right:\s*12px;[^}]*bottom:\s*10px;[^}]*width:\s*28px;[^}]*height:\s*28px;/s,
  );
  assert.match(
    html,
    /class="session-status"[^>]*data-session-status[\s\S]*data-session-status-label[\s\S]*data-session-elapsed[\s\S]*<\/div>\s*<div class="composer-card"[\s\S]*data-composer[\s\S]*data-send[\s\S]*data-cancel/,
  );
  assert.match(html, /sendButton\.hidden = running/);
  assert.match(html, /cancelButton\.hidden = !running/);
  assert.match(html, /class="loading-spinner"/);
  assert.match(html, /@keyframes loading-spin/);
  assert.match(html, /window\.setInterval\(/);
  assert.match(html, /class="composer-toolbar"/);
  assert.match(html, /class="custom-select-trigger"/);
  assert.match(html, /role="listbox" hidden/);
  assert.match(html, /data-select-kind="model"/);
  assert.match(html, /data-select-kind="effort"/);
  assert.match(html, /data-value="gpt-5\.6-sol"/);
  assert.match(html, /data-value="gpt-5\.5"/);
  assert.match(html, /data-value="ultra"/);
  assert.doesNotMatch(html, /aria-label="Agent"/);
  assert.doesNotMatch(html, /<select\b/);
  assert.match(html, /class="status-strip"/);
  assert.match(html, /data-status-usage>Context 0 tokens</);
  assert.match(html, /data-status-model title="모델 선택"/);
  assert.match(html, /data-status-effort title="추론 수준 선택"/);
  assert.match(html, /function syncSelectionControls\(/);
  assert.match(html, /model: state\.model/);
  assert.match(html, /reasoningEffort: state\.reasoningEffort/);
  assert.doesNotMatch(html, /weekly 79% left/);
  assert.doesNotMatch(html, /--af-color-|frontend\/src|agent-factory\/web/);
});

test("Chat composer grows from 20px through 144px and then uses internal scrolling", () => {
  const composer = { scrollHeight: 12, style: {} };

  resizeComposerInput(composer);
  assert.equal(composer.style.height, "20px");
  assert.equal(composer.style.overflowY, "hidden");

  composer.scrollHeight = 92;
  resizeComposerInput(composer);
  assert.equal(composer.style.height, "92px");
  assert.equal(composer.style.overflowY, "hidden");

  composer.scrollHeight = 180;
  resizeComposerInput(composer);
  assert.equal(composer.style.height, "144px");
  assert.equal(composer.style.overflowY, "auto");

  const html = render();
  assert.match(html, /resizeComposerInput\(composer\)/);
  assert.match(html, /\.session-status\s*\{[^}]*height:\s*22px;/s);
  assert.match(html, /\.session-status:empty\s*\{\s*display:\s*none;/s);
  assert.doesNotMatch(html, /if \(value === "complete"\) return "완료"/);
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
