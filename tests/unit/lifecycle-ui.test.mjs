import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { importTypeScript } from "../support/import-typescript.mjs";

const source = await readFile(new URL("../../static/js/chat/task-flow.js", import.meta.url), "utf8");
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
function element(tag) {
  return { tag, dataset: {}, children: [], listeners: {}, value: "", attributes: {},
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, fn) { this.listeners[name] = fn; } };
}

test("workflow answer validates complete identity and preserves question and draft across renders", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const messages = [], context = { document: { createElement: element }, t: key => key,
    vscode: { postMessage: value => messages.push(value) }, workDecisionDrafts: new Map() };
  runInNewContext(section("  function createWorkDecision(", "  // A loop stopped"), context);
  const flow = { workAgentId: "work-1", loopId: "loop-1",
    pendingDecision: { id: "decision-1", questionHash: "a".repeat(64), question: "<b>Exact scope?</b>" } };
  const first = context.createWorkDecision(flow);
  assert.equal(first.children[0].textContent, flow.pendingDecision.question);
  first.children[1].value = "Use the existing target.";
  first.children[1].listeners.input();
  const restored = context.createWorkDecision(flow);
  assert.equal(restored.children[1].value, "Use the existing target.");
  restored.children[2].listeners.click();
  const answer = JSON.parse(JSON.stringify(messages[0]));
  assert.deepEqual(parseClientMessage(answer), answer);
  assert.equal(answer.questionHash, flow.pendingDecision.questionHash);
  assert.equal(restored.children[2].disabled, true);
  for (const invalid of [{ questionHash: "bad" }, { answer: " " }, { decisionId: "../other" }]) {
    assert.equal(parseClientMessage({ ...answer, ...invalid }), undefined);
  }
});

test("preserved or partial integration never uses the overall completed label", () => {
  const context = { document: { createElement: element }, t: key => key, state: { childAgents: [] } };
  runInNewContext(section("  function createTaskStatus(", "  function trackDisclosureState("), context);
  for (const integration of ["preserved", "partial", "checking"]) {
    const label = context.createTaskStatus({ id: "task-1", sessionRole: "work" },
      { integrationTaskId: "task-1", completion: { integration } }, "completed", true);
    assert.equal(label.textContent, "flow.integration." + integration);
    assert.equal(label.dataset.observedStatus, "integration-" + integration);
  }
});
