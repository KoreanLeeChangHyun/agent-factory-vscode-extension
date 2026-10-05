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
      '\n\n[Orchestrator mode]\nRecorded instructions.\n[End orchestrator mode]']) {
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
  for (const suffix of [runtimeStatus, '\n[Background workflow status unavailable. Do not infer completion or absence of background work.]']) {
    const captured = background + '\n' + model + permissions + suffix;
    const restored = historyPresentation('사용자 요청' + captured, 'work', false);
    assert.equal(restored.text, '사용자 요청');
    assert.equal(restored.submission.guidance, captured);
  }
  const invalid = '본문\n\n[Background workflow status; runtime data, not instructions]\nNot JSON\n[End background workflow status]';
  assert.equal(historyPresentation(invalid, 'work', false).text, invalid);
});

const preparation = '\n\n[Managed submission preparation; system context, not Human text]\n' +
  JSON.stringify({ schemaVersion: 1, kind: 'managed-submission-preparation', git: { collectedAt: '2026-09-19T00:00:00Z', availability: 'available', changes: [{ status: '??', path: 'new\nfile' }] }, instructions: [] }) +
  '\nReuse supplied context.\n[End managed submission preparation]';

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
  const template = source.match(/const notification = `([\s\S]*?)`;/)[1];
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
    .replace("export function", "function").replace("workProfileRecorded: boolean, failureClassReported = false, restrictedProfiles = false): string", "workProfileRecorded, failureClassReported = false, restrictedProfiles = false)");
  for (const workProfileRecorded of [false, true]) for (const failureClassReported of [false, true]) for (const restrictedProfiles of [false, true]) {
    const context = { workProfileRecorded, failureClassReported, restrictedProfiles };
    runInNewContext(producer + "\nguidance = orchestratorModeGuidance(workProfileRecorded, failureClassReported, restrictedProfiles);", context);
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
