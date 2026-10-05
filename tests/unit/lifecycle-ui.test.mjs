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

test("workflow answer compatibility still validates exact decision identity without an inline card form", async () => {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const answer = { type: "workflow.answer", workAgentId: "work-1", loopId: "loop-1",
    decisionId: "decision-1", questionHash: "a".repeat(64), answer: "Use the existing target." };
  assert.deepEqual(parseClientMessage(answer), answer);
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
