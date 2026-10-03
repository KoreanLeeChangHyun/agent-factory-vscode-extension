import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { readChatSource } from "../support/chat-source.mjs";

const script = await readChatSource();
const helper = script.slice(script.indexOf("  function assistantDisplayText("), script.indexOf("  function reasoningDisplayLabel("));
const context = {};
vm.runInNewContext(helper, context);

test("managed result envelopes render only resultText", () => {
  const envelope = JSON.stringify({
    decisionKind: null,
    resultPath: "/runtime/projects/example/agents/main/runs/run/result.md",
    resultText: "진행 상황만 표시",
    status: "completed"
  });
  assert.equal(context.assistantDisplayText(envelope), "진행 상황만 표시");
  assert.equal(context.assistantDisplayText("- " + envelope), "진행 상황만 표시");
  assert.equal(context.assistantDisplayText("• " + envelope), "진행 상황만 표시");
});

test("ordinary JSON and malformed envelopes remain source-faithful", () => {
  for (const value of [
    '{"answer":"visible JSON"}',
    '{"status":"completed","resultText":"missing path"}',
    '{"status":"completed","resultPath":"/tmp/result.md","resultText":"answer","extra":true}',
    '- {"answer":"visible JSON list item"}',
    "{not json",
    "plain text"
  ]) assert.equal(context.assistantDisplayText(value), value);
});
