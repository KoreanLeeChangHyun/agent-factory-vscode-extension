import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const output = await build({
  entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"]
});
const module = { exports: {} };
runInNewContext(output.outputFiles[0].text, {
  module, exports: module.exports, Buffer, console, process, setTimeout, clearTimeout,
  global: { Date },
  require: name => name === "vscode" ? {} : require(name)
});

test("host sends approval only to current controller and rejects missing or stale decisions", async () => {
  const posted = [], calls = [];
  const manager = new module.exports.ChatPanelManager({}, {}, () => [], async () => {
    throw new Error("Approval must use the existing controller");
  });
  const managed = {
    state: { role: "verification", verifiedWorkRunId: "work-run", model: "unsupported-model", fastMode: true },
    panel: { webview: { async postMessage(message) { posted.push(message); return true; } } },
    controller: {
      approveDecision(runId, execution) { calls.push({ runId, execution }); return runId === "current-run"; }
    }
  };
  await manager.handleMessage(managed, { type: "decision.approve", runId: "current-run" });
  assert.equal(calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), { runId: "current-run", execution: { verifiedWorkRunId: "work-run" } });
  assert.equal(posted.length, 0);
  await manager.handleMessage(managed, { type: "decision.approve", runId: "old-run" });
  assert.equal(posted.at(-2).type, "decision.pending");
  assert.equal(posted.at(-2).runId, null);
  assert.equal(posted.at(-1).level, "warning");
  managed.controller = undefined;
  await manager.handleMessage(managed, { type: "decision.approve", runId: "current-run" });
  assert.equal(calls.length, 2);
  assert.equal(posted.at(-1).level, "warning");
});
