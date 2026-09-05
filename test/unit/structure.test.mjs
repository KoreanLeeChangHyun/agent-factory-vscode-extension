import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
const template = await readFile(new URL("../../templates/chat.html", import.meta.url), "utf8");
const chatScript = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
const chatStyles = await readFile(new URL("../../static/css/chat.css", import.meta.url), "utf8");
const agentClient = await readFile(new URL("../../src/infrastructure/agent-factory/agent-client.ts", import.meta.url), "utf8");
const panelManager = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
const syntaxHighlighter = await readFile(new URL("../../src/webview/syntax-highlighter.ts", import.meta.url), "utf8");

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
  assert.match(template, /src="\{\{syntaxScriptUri\}\}"/);
  assert.match(template, /src="\{\{iconUri\}\}"/);
  assert.match(template, /href="\{\{styleUri\}\}"/);
  assert.doesNotMatch(template, /<style[ >]/);
});

test("session picker appears in the composer action row and renders a list", function () {
  const actionsStartIndex = template.indexOf('class="composer-actions-start"');
  const sessionIndex = template.indexOf('id="session-button"');
  const actionsEndIndex = template.indexOf('class="composer-actions-end"');
  assert.ok(actionsStartIndex > 0);
  assert.ok(sessionIndex > actionsStartIndex);
  assert.ok(sessionIndex < actionsEndIndex);
  assert.match(template, /id="session-menu"[^>]*role="listbox"/);
  assert.match(template, /id="session-list"/);
  assert.match(template, /id="session-button"[^>]*class="utility-button"[\s\S]*?<svg/);
  assert.doesNotMatch(template, /id="session-button"[^>]*>[\s\S]*?세션 불러오기[\s\S]*?<\/button>/);
  assert.doesNotMatch(template, /id="resume-button"/);
  assert.match(chatScript, /type: "sessions\.request"/);
  assert.match(chatScript, /type: "session\.select"/);
  assert.match(chatStyles, /\.session-item/);
  assert.doesNotMatch(chatStyles, /\.session-actions/);
});

test("user question picker lists prompts and jumps to the selected message", function () {
  assert.match(template, /id="question-button"[^>]*aria-controls="question-menu"/);
  assert.match(template, /id="question-button"[^>]*>[\s\S]*?<svg/);
  assert.match(template, /id="question-menu"[^>]*role="listbox"/);
  assert.match(template, /id="question-list"/);
  assert.match(chatScript, /event\.type === "user"/);
  assert.match(chatScript, /jumpToQuestion\(question\.id\)/);
  assert.match(chatScript, /target\.scrollIntoView\(\{ block: "center" \}\)/);
  assert.match(chatScript, /target\.focus\(\{ preventScroll: true \}\)/);
  assert.match(chatStyles, /\.question-item/);
  assert.match(chatStyles, /\.message-user\.message-jump-target/);
});

test("history and user question lists share one popup width", function () {
  assert.match(template, /id="session-menu" class="utility-list-menu session-menu"/);
  assert.match(template, /id="question-menu" class="utility-list-menu question-menu"/);
  assert.match(chatStyles, /\.utility-list-menu \{[\s\S]*width: min\(440px, calc\(100vw - 36px\)\);/);
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
  assert.match(chatScript, /modelLabel\.textContent = state\.model \|\| "Default"/);
  assert.match(chatScript, /reasoningLabel\.textContent = state\.reasoning \|\| "Default"/);
  assert.doesNotMatch(chatScript, /modelLabel\.textContent = "Model "/);
  assert.doesNotMatch(chatScript, /reasoningLabel\.textContent = "Reasoning "/);
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
  assert.ok(defaults.includes("context"));
  for (const duplicate of ["model", "reasoning", "fast", "goal"]) {
    assert.ok(!defaults.includes(duplicate));
  }
  assert.match(chatScript, /composerStatusItems = new Set\(\["model", "reasoning", "fast", "goal"\]\)/);
  assert.match(chatScript, /case "context\.usage"/);
  assert.match(chatScript, /if \(!items\.includes\("context"\)\)/);
  assert.match(chatScript, /Math\.max\(0, state\.contextWindowTokens - state\.contextUsedTokens\)\.toLocaleString\("ko-KR"\) \+ " 남음"/);
  assert.match(chatScript, /meter\.setAttribute\("role", "progressbar"\)/);
  assert.match(chatScript, /fill\.style\.width = usageRatio \* 100 \+ "%"/);
  assert.match(chatScript, /Math\.round\(\(1 - usageRatio\) \* 120\)/);
  assert.match(chatStyles, /\.context-token-meter/);
  assert.match(agentClient, /last_token_usage/);
  assert.match(agentClient, /model_context_window/);
  assert.match(chatScript, /agents: "진행 " \+ state\.workUnits\.activeUnits \+ " · 작업 "/);
  assert.match(template, /id="agents-menu"[^>]*aria-label="호출된 작업자와 검증자"/);
  assert.match(chatScript, /type: "agents\.request"/);
  assert.match(chatScript, /type: "agent\.open", agentId: agent\.agentId/);
  assert.match(panelManager, /listChildSessions\(managed\.state\.agentId\)/);
  assert.match(panelManager, /actor: "human" as const/);
  assert.match(panelManager, /verifiedWorkRunId: managed\.state\.verifiedWorkRunId/);
  assert.match(agentClient, /--\$\{flag\}/);
  assert.match(agentClient, /"--verified-work-run-id"/);
});

test("composer selections remain sticky across turns and panel restoration", function () {
  assert.match(chatScript, /type: "composer\.settings"/);
  assert.match(chatScript, /saveComposerSettings\(\)/);
  assert.match(panelManager, /context\.globalState\.get\(COMPOSER_PREFERENCES_KEY\)/);
  assert.match(panelManager, /context\.globalState\.update\(COMPOSER_PREFERENCES_KEY/);
  assert.match(chatScript, /case "host\.initialize":[\s\S]*updateModeControls\(\);[\s\S]*renderTimeline\(\);/);
  assert.doesNotMatch(chatScript, /if \(state\.goalMode\) \{[\s\S]*state\.goalMode = false/);
  assert.match(chatScript, /model: state\.model,[\s\S]*reasoning: state\.reasoning,[\s\S]*fastMode: state\.fastMode,[\s\S]*goalMode: state\.goalMode/);
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
  assert.doesNotMatch(template, /run-status-marker/);
  assert.doesNotMatch(chatStyles, /\.run-status-marker/);
  assert.match(chatStyles, /@keyframes run-status-text-scan/);
  assert.match(template, /class="run-status-copy"[\s\S]*run-status-label[\s\S]*run-status-meta/);
  assert.match(chatStyles, /\.run-status-copy[\s\S]*background-clip: text[\s\S]*animation: run-status-text-scan/);
  assert.match(chatStyles, /prefers-reduced-motion: reduce[\s\S]*\.run-status-copy[\s\S]*animation: none/);
  assert.doesNotMatch(chatStyles, /\.run-status::after/);
  assert.doesNotMatch(chatStyles, /\.message-running/);
});

test("runtime status stays in the loader while concrete activity updates the timeline", function () {
  assert.match(chatScript, /case "run\.progress":[\s\S]*state\.runProgress = message\.text/);
  assert.match(chatScript, /case "run\.activity":[\s\S]*upsertActivity\(message\.id, message\.category, message\.phase, message\.text, message\.diff, message\.title\)/);
  assert.match(chatScript, /event\.type === "activity" && event\.id === id/);
  assert.match(chatStyles, /\.message-activity/);
  assert.match(chatScript, /runStatusLabel\.textContent = state\.runProgress \|\| "작업 중"/);
});

test("commands, file changes, tools, and assistant responses have distinct presentation", function () {
  assert.match(chatScript, /activityKindLabel\(event\.category\)/);
  assert.doesNotMatch(chatScript, /event\.type === "assistant" \? "응답"/);
  assert.doesNotMatch(chatScript, /return "Bash"/);
  assert.match(chatScript, /renderTerminalCommand\(content, event\.text, event\.phase, event\.title\)/);
  assert.match(chatScript, /if \(category === "file"\) return "Git 변경"/);
  assert.match(chatStyles, /\.message-activity-command \.message-content[\s\S]*font-family/);
  assert.doesNotMatch(chatStyles, /\.message-activity-command\s*\{[^}]*(?:border|background):/);
  assert.match(chatStyles, /\.message-activity-file/);
  assert.match(chatStyles, /\.message-activity-file\s*\{[^}]*border: 1px[^}]*background:/);
  assert.doesNotMatch(chatScript, /return "런타임 기록"/);
  assert.match(chatStyles, /\.message-activity-tool/);
  assert.doesNotMatch(chatStyles, /\.message-activity-tool\s*\{[^}]*(?:border|background):/);
  assert.match(chatStyles, /\.message-activity \.message-kind/);
  assert.doesNotMatch(chatStyles, /\.message-assistant\s*\{[^}]*border-left/);
  assert.doesNotMatch(chatStyles, /\.message-activity\s*\{[^}]*border-left/);
  assert.doesNotMatch(chatStyles, /\.message-activity \.message-content::before/);
});

test("recognized read commands use concise activity labels instead of Bash text", function () {
  assert.match(chatScript, /event\.title \|\| activityKindLabel\(event\.category\)/);
  assert.match(chatScript, /message\.title\.length <= 200/);
  assert.doesNotMatch(agentClient, /return truncate\(summary, 140\)/);
  assert.match(agentClient, /return summary\.trim\(\) \|\| undefined/);
  assert.match(agentClient, /title === "실행 요청 읽기"/);
  assert.match(agentClient, /return \[statusUpdate\("Main Agent가 요청을 분석 중"\)\]/);
  assert.match(agentClient, /return "실행 결과 읽기"/);
  assert.match(chatScript, /context\.title = command/);
  assert.match(chatScript, /text\.append\(context\);[\s\S]*container\.append\(row\);[\s\S]*return;/);
});

test("adjacent reads of the same skill or run document collapse into one activity", function () {
  assert.match(chatScript, /timeline: collapseAdjacentReads\(Array\.isArray\(saved\?\.timeline\)/);
  assert.match(chatScript, /normalizeSavedReadActivity\(savedEvent\)/);
  assert.match(chatScript, /event\?\.title === "실행 요청 읽기"/);
  assert.match(chatScript, /return \{ \.\.\.event, title: "실행 결과 읽기" \}/);
  assert.match(chatScript, /sameReadActivity\(previous, incoming\)/);
  assert.match(chatScript, /isReadActivityTitle\(left\.title\)/);
  assert.match(chatScript, /left\.title === right\.title/);
});

test("read activities visibly distinguish in-progress and completed phases", function () {
  assert.match(chatScript, /readActivityDisplayTitle\(title, phaseValue\)/);
  assert.match(chatScript, /return title\.replace\("Skill 읽기 · ", "Skill 읽는 중 · "\)/);
  assert.doesNotMatch(chatScript, /return "실행 요청 읽는 중"/);
  assert.match(chatScript, /return "실행 결과 읽는 중"/);
});

test("activity completion uses accessible success and failure dots instead of text labels", function () {
  assert.match(chatScript, /message-phase-" \+ \(phaseValue \|\| "started"\)/);
  assert.match(chatScript, /heading\.append\(createActivityPhase\(event\.phase\), kind\)/);
  assert.match(chatScript, /phase\.setAttribute\("aria-label", activityPhaseAccessibleLabel\(phaseValue\)\)/);
  assert.doesNotMatch(chatScript, /return "완료"/);
  assert.match(chatStyles, /\.message-phase\s*\{[^}]*width: 5px[^}]*height: 5px/);
  assert.match(chatStyles, /\.message-phase-completed\s*\{[^}]*testing-iconPassed/);
  assert.match(chatStyles, /\.message-phase-failed\s*\{[^}]*testing-iconFailed/);
});

test("terminal commands show three lines before offering an accessible ellipsis expansion", function () {
  assert.match(chatScript, /renderTerminalCommand\(content, event\.text, event\.phase, event\.title\)/);
  assert.match(chatScript, /prompt\.textContent = ">"/);
  assert.match(chatScript, /row\.append\(createActivityPhase\(phaseValue\), prompt, text\)/);
  assert.match(chatScript, /toggle\.hidden = text\.scrollHeight <= text\.clientHeight \+ 1/);
  assert.match(chatScript, /toggle\.textContent = expanded \? "접기" : "…"/);
  assert.match(chatScript, /toggle\.setAttribute\("aria-label", "전체 명령 펼치기"\)/);
  assert.match(chatScript, /toggle\.setAttribute\("aria-expanded", String\(expanded\)\)/);
  assert.match(chatStyles, /\.bash-command-text\s*\{[^}]*max-height: calc\(1\.45em \* 3\)/);
  assert.match(chatStyles, /\.bash-command-text\.is-expanded\s*\{[^}]*max-height: none/);
  assert.match(chatStyles, /\.bash-command-toggle\s*\{[^}]*position: absolute[^}]*bottom: 0/);
});

test("terminal commands and extension-aware diffs use VS Code TextMate highlighting", function () {
  assert.equal(packageJson.dependencies.shiki, "^4.4.3");
  assert.match(syntaxHighlighter, /createHighlighterCore/);
  assert.match(syntaxHighlighter, /createOnigurumaEngine/);
  assert.match(syntaxHighlighter, /@shikijs\/themes\/dark-plus/);
  assert.match(syntaxHighlighter, /@shikijs\/themes\/light-plus/);
  assert.match(syntaxHighlighter, /"\.tsx": "tsx"/);
  assert.match(syntaxHighlighter, /"\.py": "python"/);
  assert.match(chatScript, /applySyntaxHighlighting\(commandCode, command, "bash"\)/);
  assert.match(chatScript, /highlighter\.languageForPath\(item\.path\)/);
  assert.match(chatScript, /renderHighlightedTokens\(element, tokens, entry\.prefix\)/);
  assert.match(chatScript, /span\.textContent = token\.content/);
});

test("Git changes render a bounded unified diff preview with file statistics", function () {
  assert.match(chatScript, /renderGitDiff\(content, event\.diff, event\.text\)/);
  assert.match(chatScript, /Edited " \+ \(files\.length \|\| 1\)/);
  assert.match(chatScript, /summary\.textContent = "Git diff 보기"/);
  assert.match(chatScript, /line\.startsWith\("@@"\)/);
  assert.match(chatStyles, /\.git-diff-preview pre/);
  assert.match(chatStyles, /\.git-diff-addition/);
  assert.match(chatStyles, /\.git-diff-deletion/);
  assert.match(chatStyles, /\.git-diff-hunk/);
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
