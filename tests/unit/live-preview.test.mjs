import assert from "node:assert/strict";
import { runUiInNewContext as runInNewContext } from "../support/ui-localization.mjs";
import test from "node:test";
import { readChatSource } from "../support/chat-source.mjs";

const script = await readChatSource();
const handlers = script.slice(script.indexOf('      case "chat.assistant":'), script.indexOf('      case "bots.updated":'))
  + script.slice(script.indexOf('      case "chat.delta":'), script.indexOf('      case "bots.updated":', script.indexOf('      case "chat.delta":')));
const helpers = script.slice(script.indexOf("  // A complete message supersedes"), script.indexOf("  function upsertActivity("))
  + script.slice(script.indexOf("  function isDuplicateCancellation("), script.indexOf("  function appendNotice("));

function harness() {
  let id = 0;
  const context = {
    state: { timeline: [] }, renders: 0, frames: [],
    document: { hidden: false }, requestAnimationFrame(callback) { context.frames.push(callback); return context.frames.length; },
    messageElements: new Map(), messageRenderKeys: new Map(), eventVersion: () => 1, followLatest: false,
    assistantDisplayText: value => value, localizedText: value => value,
    chatInterview: { renderInterviewChoices() {} }, chatActivities: { renderDecisionActions() {} },
    createId: () => "id-" + (id += 1), scheduleTimelineRender() { context.renders += 1; }, renderRunStatus() {}, renderWorkLoopPanel() {},
    extractTaskFlows: text => ({ text, flows: [] }), currentTaskFlows: () => [], chatMarkdown: { renderAssistantMarkdown() {} }, persist() {}
  };
  runInNewContext(helpers + "\nfunction handle(message) { switch (message.type) {\n" + handlers + "\n} }", context);
  return { context, send: message => runInNewContext("handle(" + JSON.stringify(message) + ")", context) };
}

test("deltas build one live entry per stream that complete messages replace in place", () => {
  const { context, send } = harness();
  send({ type: "chat.delta", runId: "r1", stream: "commentary", id: "m:1", text: "Checking " });
  send({ type: "chat.delta", runId: "r1", stream: "commentary", id: "m:1", text: "files" });
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "toolu", text: "Partial ans" });
  assert.deepEqual(context.state.timeline.map(entry => [entry.phase, entry.text, entry.streaming]),
    [["commentary", "Checking files", true], ["final", "Partial ans", true]]);
  send({ type: "chat.assistant", runId: "r1", phase: "commentary", text: "Checking files" });
  assert.deepEqual(context.state.timeline.map(entry => [entry.phase, entry.text, Boolean(entry.streaming)]),
    [["commentary", "Checking files", false], ["final", "Partial ans", true]]);
  send({ type: "chat.assistant", runId: "r1", phase: "final", text: "Partial answer, complete." });
  assert.deepEqual(context.state.timeline.map(entry => [entry.phase, entry.text, Boolean(entry.streaming)]),
    [["commentary", "Checking files", false], ["final", "Partial answer, complete.", false]]);
});

test("invalid deltas are ignored and other runs keep their previews", () => {
  const { context, send } = harness();
  for (const message of [{ runId: "r1", stream: "reasoning", id: "x", text: "hidden" }, { runId: "r1", stream: "final", id: "x", text: "" },
    { stream: "final", id: "x", text: "no run" }]) send({ type: "chat.delta", ...message });
  assert.equal(context.state.timeline.length, 0);
  send({ type: "chat.delta", runId: "other", stream: "final", id: "a", text: "other run" });
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: "mine" });
  send({ type: "chat.assistant", runId: "r1", phase: "final", text: "mine done" });
  assert.deepEqual(context.state.timeline.map(entry => [entry.runId, entry.text, Boolean(entry.streaming)]),
    [["other", "other run", true], ["r1", "mine done", false]]);
  runInNewContext("dropLivePreviews()", context);
  assert.deepEqual(context.state.timeline.map(entry => entry.text), ["mine done"]);
});

test("same-run Goal finals replace only the latest matching preview after intervening events", () => {
  const { context, send } = harness();
  send({ type: "chat.delta", runId: "goal", stream: "final", id: "turn-a", text: "Old answer" });
  send({ type: "chat.delta", runId: "goal", stream: "commentary", id: "turn-b", text: "Checking again" });
  send({ type: "chat.assistant", runId: "goal", phase: "commentary", text: "Checking again" });
  context.state.timeline.push({ type: "activity", id: "tool-b", text: "Check B" });
  send({ type: "chat.delta", runId: "goal", stream: "final", id: "final-b", text: "Latest answer" });
  context.state.timeline.push({ type: "activity", id: "after-b", text: "After preview B" });
  send({ type: "chat.assistant", runId: "goal", text: "Latest answer complete" });
  send({ type: "chat.assistant", runId: "goal", text: "Latest answer complete" });
  assert.deepEqual(context.state.timeline.map(entry => entry.text),
    ["Checking again", "Check B", "Latest answer complete", "After preview B"]);
  assert.ok(context.state.timeline.every(entry => !entry.streaming));
});

test("missing or mismatched latest final previews append completion without moving it into an older turn", () => {
  for (const latest of [undefined, "Unrelated latest text"]) {
    const { context, send } = harness();
    if (latest) {
      send({ type: "chat.delta", runId: "goal", stream: "final", id: "a", text: "Matching" });
      send({ type: "chat.delta", runId: "goal", stream: "final", id: "b", text: latest });
    }
    context.state.timeline.push({ type: "activity", id: "tool", text: "Current activity" });
    send({ type: "chat.assistant", runId: "goal", text: "Matching complete" });
    assert.deepEqual(context.state.timeline.map(entry => entry.text), ["Current activity", "Matching complete"]);
  }
});

function fakeElement() {
  const element = { children: [], className: "", classList: { add() {} }, innerHTML: "",
    append(...nodes) { element.children.push(...nodes); }, replaceChildren(...nodes) { element.children = nodes; },
    get childNodes() { return element.innerHTML ? [element.innerHTML] : []; }, querySelectorAll: () => [] };
  return element;
}

test("growing previews re-render only their own content once per frame", () => {
  const { context, send } = harness();
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: "Intro\n\n**He" });
  assert.equal(context.renders, 1);
  const entry = context.state.timeline[0];
  const content = fakeElement();
  const element = { querySelector: () => content };
  const key = [0, "other"];
  context.messageElements.set(entry.id, element);
  context.messageRenderKeys.set(element, key);
  const rendered = [];
  context.chatMarkdown.renderAssistantMarkdown = (_content, text) => rendered.push(text);
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: "llo" });
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: "**" });
  assert.equal(context.frames.length, 1);
  context.frames[0]();
  assert.deepEqual(rendered, ["Intro\n\n**Hello**"]);
  assert.equal(key[0], 1);
  assert.equal(context.renders, 1);
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: " more" });
  context.frames[1]();
  assert.deepEqual(rendered.slice(1), ["Intro\n\n**Hello** more"]);
});

test("live previews are never persisted", () => {
  const persistence = script.slice(script.indexOf("      timeline: state.timeline.filter("), script.indexOf(".slice(-200)", script.indexOf("      timeline: state.timeline.filter(")));
  assert.match(persistence, /!event\.streaming/);
});
