import test from "node:test";
import assert from "node:assert/strict";
import { importTypeScript } from "../support/import-typescript.mjs";

test("the light Work profile is accepted and explained to Main only when configured", async () => {
  const { parseAgentModels } = await importTypeScript("src/common/types/agent-models.ts");
  const { delegatedModelGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  const models = { work: { model: "gpt-5.6-sol", reasoningEffort: "high" }, workLight: { model: "gpt-5.6-luna", reasoningEffort: "low" } };
  assert.deepEqual(parseAgentModels(models), models);
  assert.equal(parseAgentModels({ planner: {} }), undefined);
  const guidance = delegatedModelGuidance(models);
  assert.match(guidance, /workLight/);
  assert.match(guidance, /never pass a profile name such as light or heavy as a model/);
  assert.doesNotMatch(delegatedModelGuidance({ work: models.work }), /Work profiles/);
});

test("orchestrator mode sends the brief guidance, not the contract workflow", async () => {
  const { orchestratorGuidance } = await importTypeScript("src/modules/chat/session-controller.ts");
  assert.match(orchestratorGuidance, /Goal .*Scope .*Done .*Report/s);
  assert.match(orchestratorGuidance, /Do not write a task-list JSON, run announce-tasks/);
  assert.doesNotMatch(orchestratorGuidance, /taskFlow|requestHash|contract object/);
});
