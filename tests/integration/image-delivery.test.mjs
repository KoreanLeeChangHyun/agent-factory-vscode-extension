import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";

const execFileAsync = promisify(execFile);

async function importTypeScript(relativePath) {
  const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
  const output = await build({ entryPoints: [sourcePath], bundle: true, format: "esm", platform: "node", target: "node18", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
}

test("browser image bytes reach the plugin contract on submit and send", async function (t) {
  const root = await mkdtemp(join(tmpdir(), "af-image-delivery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [{ parseClientMessage }, { decodeBrowserImage }, { writeNewImageAttachment }, { ChatSessionController }, { AgentFactoryClient }] = await Promise.all([
    importTypeScript("src/protocol/validator.ts"),
    importTypeScript("src/common/image-input.ts"),
    importTypeScript("src/infrastructure/vscode/image-attachment-store.ts"),
    importTypeScript("src/modules/chat/session-controller.ts"),
    importTypeScript("src/infrastructure/agent-factory/agent-client.ts")
  ]);
  const expected = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from("fixed-png-payload")]);
  const browserMessage = parseClientMessage({
    type: "attachments.createImage", id: "image-one", name: "image.png",
    mediaType: "image/png", size: expected.byteLength, data: expected.toString("base64")
  });
  assert.ok(browserMessage);
  const staged = decodeBrowserImage(browserMessage.data, browserMessage.size, browserMessage.mediaType);
  const stagedPath = join(root, "image.png");
  await writeNewImageAttachment(stagedPath, staged);
  assert.deepEqual(await readFile(stagedPath), expected);

  const controllerCalls = [];
  const runtime = {
    activeRun: async () => undefined,
    submit: async (agentId, message, execution, images) => {
      controllerCalls.push({ operation: "submit", agentId, message, execution, images });
      return { agentId, runId: "run-submit" };
    },
    send: async (agentId, message, execution, images) => {
      controllerCalls.push({ operation: "send", agentId, message, execution, images });
      return { agentId, runId: "run-send" };
    },
    updates: async (_agentId, _runId, cursor) => ({ cursor, updates: [] }),
    status: async () => ({ status: "completed" }),
    result: async () => ({ status: "completed", text: "ok" }),
    cancel: async () => {}, goal: async () => ({}), capabilities: async () => ({}),
    listSessions: async () => [], listChildSessions: async () => []
  };
  const events = {
    onBound() {}, onRunningChanged() {}, onAssistantText() {}, onProgress() {},
    onUsage() {}, onActivity() {}, onError(message) { assert.fail(message); }
  };
  const attachment = [{
    id: browserMessage.id, name: browserMessage.name, kind: "image",
    uri: pathToFileURL(stagedPath).toString(), mediaType: browserMessage.mediaType, size: browserMessage.size
  }];
  await new ChatSessionController(runtime, events, undefined, { pollIntervalMs: 0, maxPolls: 1 }).send("inspect", attachment, {});
  await new ChatSessionController(runtime, events, "main-existing", { pollIntervalMs: 0, maxPolls: 1 }).send("inspect", attachment, {});
  assert.deepEqual(controllerCalls.map(call => call.operation), ["submit", "send"]);
  for (const call of controllerCalls) {
    assert.match(call.message, /첨부 참조:[\s\S]*image\.png/);
    assert.deepEqual(call.images, [{ path: stagedPath, mediaType: "image/png" }]);
  }

  const pluginRuntime = fileURLToPath(new URL("../../../plugin/skills/agent/runtime/", import.meta.url));
  const python = [
    "import hashlib,json,sys", "from pathlib import Path", "sys.path.insert(0, sys.argv[1])",
    "contract=json.loads(Path(sys.argv[2]).read_text(encoding='utf-8'))",
    "from image_input import read_agent_input", "request, images = read_agent_input(Path(sys.argv[2]))",
    "print(json.dumps({'message': request.decode('utf-8'), 'siblings': [{'path': i['path'], 'exists': (Path(sys.argv[2]).parent / i['path']).is_file()} for i in contract['images']], 'images': [{'size': len(i['content']), 'sha256': hashlib.sha256(i['content']).hexdigest(), 'mediaType': i['mediaType']} for i in images]}))"
  ].join("; ");
  const pluginObservations = [];
  const client = new AgentFactoryClient("/unused/exec.py", root);
  const supported = { model: false, reasoning: false, fast: false, goal: false, images: true };
  client.capabilities = async () => ({ submit: supported, send: supported });
  client.command = async (arguments_) => {
    const contractPath = arguments_[arguments_.indexOf("--input-file") + 1];
    const observed = await execFileAsync("python3", ["-c", python, pluginRuntime, contractPath], { encoding: "utf8" });
    pluginObservations.push(JSON.parse(observed.stdout));
    const agentId = arguments_[arguments_.indexOf("--agent") + 1];
    return { schemaVersion: "0.1.0", kind: "ack", status: "accepted", agentId, runId: `run-${arguments_[0]}` };
  };
  for (const call of controllerCalls) {
    await client[call.operation](call.agentId, call.message, call.execution, call.images);
  }
  const digest = createHash("sha256").update(expected).digest("hex");
  assert.equal(pluginObservations.length, 2);
  for (const observation of pluginObservations) {
    assert.match(observation.message, /첨부 참조:[\s\S]*image\.png/);
    assert.deepEqual(observation.siblings, [{ path: "00.png", exists: true }]);
    assert.deepEqual(observation.images, [{ size: expected.byteLength, sha256: digest, mediaType: "image/png" }]);
  }
});
