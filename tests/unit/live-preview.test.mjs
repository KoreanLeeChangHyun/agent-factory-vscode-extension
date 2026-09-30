import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runUiInNewContext as runInNewContext } from "../support/ui-localization.mjs";
import test from "node:test";

const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
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
    assistantDisplayText: value => value,
    createId: () => "id-" + (id += 1), scheduleTimelineRender() { context.renders += 1; }, renderRunStatus() {}, renderWorkLoopPanel() {},
    extractTaskFlows: () => ({ flows: [] }), currentTaskFlows: () => [], renderMath() {}, persist() {}
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
  context.markdown = { render: text => { rendered.push(text); return "<" + text + ">"; } };
  context.document.createElement = () => fakeElement();
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: "llo" });
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: "**" });
  assert.equal(context.frames.length, 1);
  context.frames[0]();
  assert.deepEqual(rendered, ["Intro\n\n", "**Hello**"]);
  assert.equal(key[0], 1);
  assert.equal(context.renders, 1);
  // The finished block is kept; only the tail renders again.
  send({ type: "chat.delta", runId: "r1", stream: "final", id: "b", text: " more" });
  context.frames[1]();
  assert.deepEqual(rendered.slice(2), ["**Hello** more"]);
});

test("block boundaries ignore blank lines inside code fences", () => {
  const { context } = harness();
  const boundary = text => runInNewContext("stablePreviewBoundary(" + JSON.stringify(text) + ", 0)", context);
  assert.equal(boundary("a\n\nb"), 3);
  assert.equal(boundary("a\n\n```\ncode\n\nmore"), 3);
  assert.equal(boundary("```\nx\n\n```\n\ntail"), 12);
  assert.equal(boundary("no break yet"), 0);
});

test("live previews are never persisted", () => {
  const persistence = script.slice(script.indexOf("      timeline: state.timeline.filter("), script.indexOf(".slice(-200)", script.indexOf("      timeline: state.timeline.filter(")));
  assert.match(persistence, /!event\.streaming/);
});
