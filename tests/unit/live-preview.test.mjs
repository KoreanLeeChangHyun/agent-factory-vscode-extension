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
    state: { timeline: [] }, renders: 0,
    createId: () => "id-" + (id += 1), scheduleTimelineRender() { context.renders += 1; }, renderRunStatus() {}, renderWorkLoopPanel() {},
    extractTaskFlows: () => ({ flows: [] }), currentTaskFlows: () => [], persist() {}
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

test("live previews are never persisted", () => {
  const persistence = script.slice(script.indexOf("      timeline: state.timeline.filter("), script.indexOf(".slice(-200)", script.indexOf("      timeline: state.timeline.filter(")));
  assert.match(persistence, /!event\.streaming/);
});
