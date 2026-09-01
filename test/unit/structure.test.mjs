import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const template = await readFile(new URL("../../templates/chat.html", import.meta.url), "utf8");
const chatScript = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
const chatStyles = await readFile(new URL("../../static/css/chat.css", import.meta.url), "utf8");

test("extension runs in the workspace extension host", function () {
  assert.deepEqual(packageJson.extensionKind, ["workspace"]);
  assert.equal(packageJson.main, "./dist/extension.js");
});

test("chat is restored as an editor webview panel", function () {
  assert.ok(packageJson.activationEvents.includes("onWebviewPanel:agentFactory.mainChat"));
});

test("main chat can be added from the editor tab context menu", function () {
  const items = packageJson.contributes.menus["editor/title/context"];
  assert.ok(items.some(function (item) {
    return item.command === "agentFactory.mainChat.open";
  }));
});

test("an active main chat exposes an add button in the editor title", function () {
  const items = packageJson.contributes.menus["editor/title"];
  const add = items.find(function (item) {
    return item.command === "agentFactory.mainChat.open";
  });
  assert.equal(add.when, "activeWebviewPanelId == agentFactory.mainChat");
  const command = packageJson.contributes.commands.find(function (item) {
    return item.command === "agentFactory.mainChat.open";
  });
  assert.equal(command.icon, "$(add)");
});

test("an active main chat can be renamed from the tab context menu", function () {
  const items = packageJson.contributes.menus["editor/title/context"];
  const rename = items.find(function (item) {
    return item.command === "agentFactory.mainChat.rename";
  });
  assert.equal(rename.when, "activeWebviewPanelId == agentFactory.mainChat");
});

test("chat template uses external static assets and a nonce CSP", function () {
  assert.match(template, /Content-Security-Policy/);
  assert.match(template, /script-src 'nonce-\{\{nonce\}\}'/);
  assert.match(template, /src="\{\{scriptUri\}\}"/);
  assert.match(template, /src="\{\{markdownScriptUri\}\}"/);
  assert.match(template, /src="\{\{iconUri\}\}"/);
  assert.match(template, /href="\{\{styleUri\}\}"/);
  assert.doesNotMatch(template, /<style[ >]/);
});

test("resume remains available after the empty state is hidden", function () {
  const resumeIndex = template.indexOf('id="resume-button"');
  const timelineIndex = template.indexOf('id="timeline"');
  const emptyStateIndex = template.indexOf('id="empty-state"');
  assert.ok(resumeIndex > 0);
  assert.ok(resumeIndex < timelineIndex);
  assert.ok(resumeIndex < emptyStateIndex);
  assert.match(chatStyles, /\.session-actions/);
});

test("composer exposes separate model and reasoning controls", function () {
  assert.match(template, /id="model-button"/);
  assert.match(template, /id="reasoning-button"/);
  assert.doesNotMatch(template, /id="model-reasoning-button"/);
  assert.match(template, /id="model-menu"/);
  assert.match(template, /id="reasoning-menu"/);
  assert.match(template, /aria-haspopup="menu"/);
  assert.match(chatScript, /role", "menuitemradio"/);
  assert.doesNotMatch(chatScript, /settings\.open/);
  assert.match(template, /id="fast-mode-button"/);
  assert.match(template, /id="goal-mode-button"/);
});

test("composer uses one SVG send button that becomes the stop control", function () {
  assert.match(template, /id="send-icon"/);
  assert.match(template, /id="stop-icon"/);
  assert.doesNotMatch(template, /id="stop-button"/);
  assert.match(chatScript, /sendButton\.classList\.toggle\("is-running"/);
});

test("status bar includes active Work and Verification counts", function () {
  const defaults = packageJson.contributes.configuration.properties[
    "agentFactory.mainChat.statusItems"
  ].default;
  assert.ok(defaults.includes("agents"));
});

test("running state appears above the composer with elapsed time and interrupt guidance", function () {
  const runStatusIndex = template.indexOf('id="run-status"');
  const composerIndex = template.indexOf('class="composer"');
  assert.ok(runStatusIndex > 0);
  assert.ok(runStatusIndex < composerIndex);
  assert.match(template, /role="status"/);
  assert.match(template, /id="run-elapsed"/);
  assert.match(template, /Esc로 중단/);
  assert.match(chatScript, /aria-busy/);
  assert.match(chatScript, /formatElapsed/);
  assert.match(chatStyles, /\.run-status/);
  assert.doesNotMatch(chatStyles, /\.message-running/);
});

test("runtime activity streams into the timeline instead of the loading status", function () {
  assert.match(chatScript, /case "run\.progress":[\s\S]*appendActivity\(message\.text\)/);
  assert.match(chatScript, /type: "activity"/);
  assert.match(chatStyles, /\.message-activity/);
  assert.match(chatScript, /runStatusLabel\.textContent = "작업 중"/);
  assert.doesNotMatch(chatScript, /runStatusLabel\.textContent = state\.runProgress/);
});

test("assistant responses render safe local Markdown", function () {
  const markdownIndex = template.indexOf('src="{{markdownScriptUri}}"');
  const chatIndex = template.indexOf('src="{{scriptUri}}"');
  assert.ok(markdownIndex > 0);
  assert.ok(markdownIndex < chatIndex);
  assert.match(chatScript, /markdownit\(\{ html: false, linkify: true/);
  assert.match(chatScript, /renderAssistantMarkdown\(content, event\.text\)/);
  assert.match(chatStyles, /\.markdown-body h1/);
  assert.match(chatStyles, /\.markdown-body pre code/);
  assert.doesNotMatch(chatScript, /innerHTML = event\.text/);
});

test("reasoning options match the installed runtime capability", function () {
  assert.match(chatScript, /reasoning: \["", "none", "low", "medium", "high", "xhigh", "max"\]/);
  assert.doesNotMatch(chatScript, /reasoning: \[[^\]]*"minimal"/);
});
