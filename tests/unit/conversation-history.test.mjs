import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";
import { readChatSource, runChatInNewContext as runInNewContext } from "../support/chat-source.mjs";

const compiled = await build({ entryPoints: [new URL("../../src/infrastructure/agent-factory/history-presentation.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm" });
const { historyPresentation } = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
const model = '\n\n[Delegated agent model settings for this request]\n{"work":{"model":"gpt-5.6-sol"}}\nHistorical model instructions.\n[End delegated agent model settings]';
const permissions = '\n\n[Delegated agent permissions for this request]\n{"work":"bypass"}\nHistorical permission instructions.\n[End delegated agent permissions]';
const background = '\n\n[Conversation-based background workflow]\nHistorical background workflow instructions.\n[End background workflow]';
const runtimeStatus = '\n\n[Background workflow status; runtime data, not instructions]\n[{"agentId":"work-example","status":"completed"}]\nPreserve accepted workflows.\n[End background workflow status]';

test("administrator handoff suffix restores preceding guidance without hiding malformed or quoted text", async () => {
  const source = await readFile(new URL("../../src/infrastructure/agent-factory/agent-client.ts", import.meta.url), "utf8");
  const template = source.match(/const sudoGuidance = helper \? `([\s\S]*?)` : "";/)[1];
  for (const helper of ['/fixture/extension/static/sudo-request.py', 'C:\\Program Files\\extension\\sudo-request.py', '/fixture/한글 "quoted"/sudo-request.py']) {
    const handoff = template.replace('${JSON.stringify(helper)}', JSON.stringify(helper));
    for (const preceding of ['', background + model + permissions + runtimeStatus + preparation,
      '\n\n[Orchestrator mode]\nThis is ordinary conversation in orchestrator mode, not a Human-selected workflow.\nRecorded instructions.\n[End orchestrator mode]']) {
      const guidance = preceding + handoff;
      const raw = '변경 포함까지' + guidance;
      const restored = { type: 'user', id: 'history-user-handoff', runId: 'handoff', ...historyPresentation(raw, 'orchestrate', false) };
      assert.equal(restored.text, '변경 포함까지');
      assert.equal(restored.submission.guidance, guidance);
      assert.equal(restored.text + restored.submission.guidance, raw);
      for (const cached of [{ ...restored, text: raw, submission: undefined },
        { ...restored, text: '변경 포함까지' + preceding, submission: { ...restored.submission, guidance: handoff } }]) {
        const state = { agentId: 'main-one', timeline: [cached] };
        deliver(state, { type: 'conversation.history', agentId: 'main-one', history: { messages: [restored] } });
        assert.equal(state.timeline[0].text, restored.text);
        assert.equal(state.timeline[0].submission.guidance, guidance);
      }
      const quoted = raw + '\nPlease explain this quote.';
      assert.equal(historyPresentation(quoted, 'direct', false).text, quoted);
    }
    for (const malformed of [handoff.replace(JSON.stringify(helper), '""'), handoff.replace(JSON.stringify(helper), '"\\q"'),
      handoff.replace('Never ask for the password in a normal chat message.', 'User-authored text.')]) {
      const raw = '원문' + malformed;
      assert.equal(historyPresentation(raw, 'direct', false).text, raw);
    }
  }
});

test("runtime status suffix does not prevent separation of preceding instructions", () => {
  const snapshot = [{ agentId: 'scribe-example', runId: 'run-example', status: 'completed',
    task: { title: '한국어 [}] "quoted" \\ path', nested: ['[End background workflow status]', { text: 'line\nnext' }] } }];
  const prettyStatus = '\n\n[Background workflow status; runtime data, not instructions]\n' +
    JSON.stringify(snapshot, null, 2) + '\nPreserve accepted workflows.\n[End background workflow status]';
  const crlfStatus = prettyStatus.replace(JSON.stringify(snapshot, null, 2), JSON.stringify(snapshot, null, 2).replaceAll('\n', '\r\n'));
  for (const suffix of [runtimeStatus, prettyStatus, crlfStatus,
    '\n[Background workflow status unavailable. Do not infer completion or absence of background work.]']) {
    // Envelope delimiters use LF; JSON whitespace can include CRLF.
    const captured = background + '\n' + model + permissions + suffix;
    const restored = historyPresentation('사용자 요청' + captured, 'work', false);
    assert.equal(restored.text, '사용자 요청');
    assert.equal(restored.submission.guidance, captured);
  }
  const invalid = '본문\n\n[Background workflow status; runtime data, not instructions]\nNot JSON\n[End background workflow status]';
  assert.equal(historyPresentation(invalid, 'work', false).text, invalid);
  for (const text of ['전부다 배정 시켜서 테스트 해주셈', 'docs 커밋좀',
    '바로 위 응답의 다음 결정 요청에 한해 진행하세요.\n승인 대상: 초안 검토입니다.\n되돌릴 수 없는 작업은 포함되지 않습니다.']) {
    const raw = text + prettyStatus;
    assert.equal(historyPresentation(raw, 'orchestrate', false).text, text);
    assert.equal(historyPresentation(raw, 'orchestrate', false).submission.guidance, prettyStatus);
    const quoted = '사용자님 코드\n```json\n' + prettyStatus + '\n```';
    assert.equal(historyPresentation(quoted + runtimeStatus, 'direct', false).text, quoted);
    assert.equal(historyPresentation(text + prettyStatus + '\n이 인용을 설명해 주세요.', 'direct', false).text,
      text + prettyStatus + '\n이 인용을 설명해 주세요.');
  }
  for (const body of ['[\n {"agentId": "example"}\n', '[\n {"agentId": "example",}\n]\nPreserve.',
    '{"agentId":"example"}\nPreserve.', '[]', '[] trailing\nPreserve.']) {
    const raw = '인용\n\n[Background workflow status; runtime data, not instructions]\n' + body + '\n[End background workflow status]';
    assert.equal(historyPresentation(raw, 'direct', false).text, raw);
  }
});

const preparation = '\n\n[Managed submission preparation; system context, not Human text]\n' +
  JSON.stringify({ schemaVersion: 1, kind: 'managed-submission-preparation', git: { collectedAt: '2026-09-19T00:00:00Z', availability: 'available', changes: [{ status: '??', path: 'new\nfile' }] }, instructions: [] }) +
  '\nReuse supplied context.\n[End managed submission preparation]';

test("queued history separates each captured suffix and repairs only equivalent raw cache", () => {
  const bodies = ['한국어 <tag> & $HOME\n\n```js\nconst s = "[Orchestrator mode]";\n```\n> [End orchestrator mode]',
    '두 번째\n\n첨부 참조:\n- [image] image.png: file:///fixture/image.png (image/png, 12 bytes)'];
  const batch = (parts) => parts.map((part, index) => `--- 대기 메시지 ${index + 1} 시작 ---\n${part}\n--- 대기 메시지 ${index + 1} 끝 ---`).join('\n\n');
  const raw = batch(bodies.map(body => body + background + model)) + preparation;
  const restored = { type: 'user', id: 'history-user-queued', runId: 'queued', ...historyPresentation(raw, 'orchestrate', false) };
  assert.equal(restored.text, batch(bodies));
  assert.equal(restored.submission.guidance, (background + model).repeat(2) + preparation);
  assert.equal(restored.capturedRequest, raw);
  const answer = { type: 'assistant', id: 'history-result-queued', runId: 'queued', phase: 'final', text: '답변' };
  const live = { type: 'user', id: 'live', text: '다음 질문' };
  for (const timeline of [[], [{ ...restored, text: raw, submission: undefined, capturedRequest: undefined }, answer, live],
    [{ ...restored, text: raw, submission: undefined, capturedRequest: undefined }, live]]) {
    const state = { agentId: 'main-one', timeline };
    const event = { type: 'conversation.history', agentId: 'main-one', history: { messages: [restored, answer] } };
    deliver(state, event);
    deliver(state, event);
    assert.deepEqual(Array.from(state.timeline, item => item.text), timeline.length ? [batch(bodies), '답변', '다음 질문'] : [batch(bodies), '답변']);
  }
  for (const original of [batch(bodies), 'Explain:\n' + raw, batch(bodies.map(body => body + background)).replace('메시지 2 시작', '메시지 3 시작')]) {
    const result = historyPresentation(original, 'direct', false);
    // The final preparation remains a recognized suffix even in an unrecognized batch.
    assert.equal(result.text + (result.submission.guidance || ''), original);
  }
  const changed = { type: 'user', id: restored.id, text: raw + 'different' };
  const state = { agentId: 'main-one', timeline: [changed] };
  deliver(state, { type: 'conversation.history', agentId: 'main-one', history: { messages: [restored, answer] } });
  assert.equal(state.timeline.find(item => item.id === changed.id), changed);
});

test("user-authored fenced markers stay visible even when real guidance follows", () => {
  for (const fence of ['```', '~~~', '````']) {
    const body = '인용한 내부 마커\n' + fence + '\n본문' + background + model + '\n' + fence;
    const restored = historyPresentation(body + permissions + preparation, 'direct', false);
    assert.equal(restored.text, body);
    assert.equal(restored.submission.guidance, permissions + preparation);
    const unclosed = '설명\n' + fence + '\n예제' + background + model;
    assert.equal(historyPresentation(unclosed, 'direct', false).text, unclosed);
  }
  const quoted = '> [Orchestrator mode]\n> 사용자님 인용\n> [End orchestrator mode]';
  assert.equal(historyPresentation(quoted + preparation, 'direct', false).text, quoted);
  const literal = '인용\n\n[Orchestrator mode]\n사용자님 원문\n[End orchestrator mode]';
  assert.equal(historyPresentation(literal + preparation, 'direct', false).text, literal);
  // Even an exact captured block quoted by the user must survive the one
  // app-added copy of that same envelope.
  assert.equal(historyPresentation('인용' + model + model, 'work', false).text, '인용' + model);
});

test("preparation envelopes preserve exact bytes and quoted or malformed user text", () => {
  const raw = '원문\r\n' + background + preparation;
  const restored = historyPresentation(raw, 'work', false);
  assert.equal(restored.text, '원문\r\n');
  assert.equal(restored.text + restored.submission.guidance, raw);
  for (const value of [raw + '\nExplain this.', raw.replace('"schemaVersion":1', '"schemaVersion":2'), raw.replace('"instructions":[]', '"instructions":null')]) {
    assert.equal(historyPresentation(value, 'work', false).text, value);
  }
});

const script = await readChatSource();
const handler = script.slice(script.indexOf('      case "conversation.history":'), script.indexOf('      case "sessions.open":'));
function deliver(state, message) {
  runInNewContext(`switch (message.type) { ${handler} }`, { state, message, renderTimeline() {}, scheduleTimelineRender() {}, updateModeControls() {}, persist() {} });
}
const messages = [
  { type: "user", id: "u1", runId: "run-1", text: "question" },
  { type: "assistant", id: "a1", runId: "run-1", text: "answer", phase: "final" }
];
test("empty restored tab displays history once without replacing live or cached messages", () => {
  const state = { agentId: "main-one", conversationId: "conversation-one", timeline: [] };
  const message = { type: "conversation.history", agentId: "main-one", history: { conversationId: "conversation-one", messages } };
  deliver(state, message);
  assert.deepEqual(Array.from(state.timeline, item => item.text), ["question", "answer"]);
  deliver(state, message);
  assert.equal(state.timeline.length, 2);
  state.timeline.push({ type: "user", text: "new live request" });
  deliver(state, message);
  assert.equal(state.timeline.length, 3);
});
test("late history cannot repopulate a cleared conversation or a different selected Agent", () => {
  const state = { agentId: "main-two", conversationId: "conversation-two", timeline: [] };
  deliver(state, { type: "conversation.history", agentId: "main-one", history: { conversationId: "conversation-two", messages } });
  deliver(state, { type: "conversation.history", agentId: "main-two", history: { conversationId: "conversation-one", messages } });
  assert.equal(state.timeline.length, 0);
});

test("restored request separates exact captured instructions from user text and restores the route", () => {
  const restored = historyPresentation("테스트" + model + permissions, "work", false);
  assert.equal(restored.text, "테스트");
  assert.equal(restored.submission.guidance, model + permissions);
  assert.equal(restored.submission.taskMode, "work");
  const workflow = '\n\n[Workflow guidance for this message only: design]\nOld design text.\n[End workflow guidance]';
  const designed = historyPresentation("Design this" + model + workflow, "plan-work", true);
  assert.equal(designed.submission.businessMode, "design");
  assert.equal(designed.submission.goal, true);
  assert.equal(designed.text + designed.submission.guidance, "Design this" + model + workflow);
  for (const original of ["literal [Delegated agent model settings for this request]", "quoted" + model + "\nPlease explain this.", "text\n\n[Delegated agent permissions for this request]\nnot JSON\n[End delegated agent permissions]"]) {
    assert.equal(historyPresentation(original, "direct", false).text, original);
  }
});

test("already cached raw history is repaired without replacing other messages", () => {
  const original = "테스트" + model + permissions;
  const restored = { type: "user", id: "history-user-run-1", runId: "run-1", ...historyPresentation(original, "work", false) };
  const live = { type: "user", id: "live", text: original };
  const state = { agentId: "main-one", timeline: [{ type: "user", id: restored.id, text: original }, live] };
  deliver(state, { type: "conversation.history", agentId: "main-one", history: { messages: [restored] } });
  assert.equal(state.timeline[0].text, "테스트");
  assert.equal(state.timeline[0].submission.guidance, model + permissions);
  assert.equal(state.timeline[1], live);
});

test("restored guidance uses the existing closed details renderer", () => {
  const elements = [];
  const element = tag => ({ tag, open: false, children: [], classList: { add() {} },
    setAttribute() {}, append(...children) { this.children.push(...children); }, prepend(child) { this.children.unshift(child); } });
  const content = element("div");
  const renderer = script.slice(script.indexOf("  function renderSubmission("), script.indexOf("  function renderTimeline()"));
  runInNewContext(`${renderer}\nrenderSubmission(content, submission);`, {
    content, submission: historyPresentation("테스트" + background + model + permissions + preparation, "work", false).submission,
    t: value => value, createModeIcon: () => element("svg"),
    document: { createElement(tag) { const node = element(tag); elements.push(node); return node; } }
  });
  const details = elements.find(node => node.tag === "details");
  assert.ok(details);
  assert.equal(details.open, false);
  assert.equal(elements.find(node => node.tag === "pre").textContent, background + model + permissions + preparation);
});

test("background workflow history separates captured blocks and repairs partially parsed cache", () => {
  const original = "작업 목록을 만들어 주세요";
  const restored = { type: "user", id: "history-user-run-background", runId: "run-background",
    ...historyPresentation(original + background + model + permissions, "work", false) };
  assert.equal(restored.text, original);
  assert.equal(restored.submission.guidance, background + model + permissions);
  const partial = { ...restored, text: original + background,
    submission: { ...restored.submission, guidance: model + permissions } };
  const live = { ...partial, id: "live-background" };
  const state = { agentId: "main-one", timeline: [partial, live] };
  const message = { type: "conversation.history", agentId: "main-one", history: { messages: [restored] } };
  deliver(state, message);
  assert.equal(state.timeline[0].text, original);
  assert.equal(state.timeline[0].submission.guidance, background + model + permissions);
  assert.equal(state.timeline[1], live);
  deliver(state, message);
  assert.equal(state.timeline.length, 2);
  for (const text of [original + background + "\nExplain this quote.", original + '\n\n[Conversation-based background workflow]\nIncomplete']) {
    assert.equal(historyPresentation(text, "work", false).text, text);
  }
});


test("automatic continuation envelopes are collapsed without losing their captured content", async () => {
  const source = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  const match = source.match(/const notification\s*=\s*(?:previous\?\.message\s*\?\?\s*)?`(\[Background workflow continuation[^`]*?)`;/);
  assert.ok(match, "the production background continuation template must be extracted");
  const template = match[1];
  const notification = template.replace('${JSON.stringify(child)}', JSON.stringify({ agentId: "work-example", runId: "run-example", status: "completed" }));
  for (const suffix of ["", background + runtimeStatus, background + runtimeStatus + preparation]) {
    const restored = historyPresentation(notification + suffix, "work", false);
    assert.equal(restored.text, "");
    assert.equal(restored.submission.backgroundContinuation, true);
    assert.equal(restored.submission.guidance, notification + suffix);
  }
  for (const text of ["Explain this:\n" + notification, notification + "\nPlease explain.", notification.replace('"runId":"run-example"', '"other":"run-example"')]) {
    assert.equal(historyPresentation(text, "work", false).text, text);
  }
});

test("engine results distinguish complete internal envelopes from real and quoted user requests", async () => {
  const source = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  const template = source.match(/const message = previous\?\.message \?\? (`\[Engine workflow result[\s\S]*?`);/)[1];
  for (const pendingDecision of [undefined, { question: "Internal bookkeeping", decisionId: "decision-one" }]) {
    const context = { flow: { loopId: "loop-one", status: pendingDecision ? "needs-human-decision" : "completed", pendingDecision } };
    runInNewContext(`globalThis.notification = ${template};`, context);
    const notification = context.notification;
    for (const suffix of ["", background + runtimeStatus + preparation]) {
      const raw = notification + suffix;
      const restored = { type: "user", id: "history-user-engine", runId: "engine", ...historyPresentation(raw, "direct", false) };
      assert.equal(restored.text, "");
      assert.equal(restored.submission.backgroundContinuation, true);
      assert.equal(restored.submission.guidance, raw);
      for (const cached of [[], [{ ...restored, text: raw, submission: undefined }],
        [{ ...restored, text: notification, submission: { ...restored.submission, backgroundContinuation: undefined, guidance: suffix } }]]) {
        const answer = { type: "assistant", id: "history-result-engine", runId: "engine", phase: "final", text: "수정 결과입니다." };
        const human = { type: "user", id: "actual-question", runId: "human", text: "수정해 주세요." };
        const state = { agentId: "main-one", conversationId: "conversation-one", timeline: cached.length ? [...cached, human, answer] : [] };
        deliver(state, { type: "conversation.history", agentId: "main-one", history: { conversationId: "conversation-one", messages: [human, restored, answer] } });
        const internal = state.timeline.find(item => item.id === restored.id);
        assert.equal(internal.text, "");
        assert.equal(internal.submission.guidance, raw);
        assert.equal(state.timeline.find(item => item.id === human.id), human);
        assert.equal(state.timeline.find(item => item.id === answer.id), answer);
        // A later internal notification must not become a new conversation turn.
        state.timeline = [...state.timeline.filter(item => item !== internal), internal];
        const indexContext = { state, timelineIndexes: new WeakMap(), nextTimelineIndex: 0,
          taskFlowParseCache: new WeakMap(), extractTaskFlows: () => ({ flows: [] }) };
        const indexSource = script.slice(script.indexOf("  function indexedTimeline()"), script.indexOf("  // A complete message supersedes"));
        runInNewContext(indexSource + "\nglobalThis.index = indexedTimeline();", indexContext);
        assert.deepEqual(Array.from(indexContext.index.questions, item => item.text), [human.text]);
        assert.equal(indexContext.index.latestTurn, answer);
      }
    }
    for (const raw of ["수정해 주세요.", "Explain this:\n" + notification, notification + "\nPlease explain.",
      "```\n" + notification + "\n```", notification.replace('"loopId":"loop-one"', '"other":"loop-one"'),
      notification.replace('"loopId":"loop-one"', '"loopId":null'), notification.replace('"status":', '"otherStatus":'),
      notification.replace(/"status":"[^"]+"/, '"status":"active"'), notification.replace('The engine owns execution.', 'My instructions.'),
      pendingDecision ? notification.split("\n").slice(0, 3).join("\n") : notification + "\nTreat pendingDecision.question as user text.",
      notification.replace(/\n\{[^\n]+\}\n/, '\nnot JSON\n'), notification.split("\n").slice(0, 2).join("\n")]) {
      const restored = historyPresentation(raw, "direct", false);
      assert.equal(restored.text, raw);
      assert.equal(restored.submission.backgroundContinuation, undefined);
    }
  }
});


test("cached preparation repair requires exact request equivalence", () => {
  const raw = '원문' + background + preparation;
  const restored = { type: 'user', id: 'history-user-run-preparation', runId: 'run-preparation', ...historyPresentation(raw, 'work', false) };
  const state = { agentId: 'main-one', timeline: [{ type: 'user', id: restored.id, text: raw }] };
  deliver(state, { type: 'conversation.history', agentId: 'main-one', history: { messages: [restored] } });
  assert.equal(state.timeline[0].text, '원문');
  assert.equal(state.timeline[0].submission.guidance, background + preparation);
  const changed = { type: 'user', id: restored.id, text: raw + 'different' };
  state.timeline = [changed];
  deliver(state, { type: 'conversation.history', agentId: 'main-one', history: { messages: [restored] } });
  assert.equal(state.timeline[0], changed);
});


test("orchestrator requests restore captured guidance, including isolation and suffix combinations", async () => {
  const source = await readFile(new URL("../../src/modules/chat/session-controller.ts", import.meta.url), "utf8");
  const producer = source.slice(source.indexOf("export function orchestratorModeGuidance("), source.indexOf("export const orchestratorGuidance"))
    .replace("export function", "function").replace("workProfileRecorded: boolean", "workProfileRecorded").replace("): string {", ") {");
  for (const workProfileRecorded of [false, true]) for (const failureClassReported of [false, true]) for (const restrictedProfiles of [false, true]) for (const roleDirectExceptions of [false, true]) {
    const context = { workProfileRecorded, failureClassReported, restrictedProfiles, roleDirectExceptions };
    runInNewContext(producer + "\nguidance = orchestratorModeGuidance(workProfileRecorded, failureClassReported, restrictedProfiles, roleDirectExceptions);", context);
    for (const isolation of ["", "\n\n[Work isolation: task Work Units]\nRecorded isolation instructions.\n[End Work isolation]", "\n\n[Work isolation]\nUnavailable isolation instructions.\n[End Work isolation]"]) {
      for (const suffix of ["", model + permissions + isolation + runtimeStatus + preparation]) {
        const text = "원문\n\n첨부 참조:\n- [image] image.png: file:///fixture/image.png (image/png, 9371 bytes)";
        const guidance = context.guidance + suffix;
        const restored = historyPresentation(text + guidance, "orchestrate", false);
        assert.equal(restored.text, text);
        assert.equal(restored.submission.guidance, guidance);
        assert.equal(restored.submission.taskMode, "orchestrate");
        assert.equal(restored.text + restored.submission.guidance, text + guidance);
        assert.equal(historyPresentation(text + guidance + "\nExplain this quote.", "direct", false).text, text + guidance + "\nExplain this quote.");
      }
    }
  }
  const incomplete = "원문\n\n[Orchestrator mode]\nIncomplete";
  assert.equal(historyPresentation(incomplete, "orchestrate", false).text, incomplete);
});
