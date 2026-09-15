import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";

async function importTypeScript(relativePath) {
  const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
  const output = await build({ entryPoints: [sourcePath], bundle: true, format: "esm", platform: "node", target: "node18", write: false });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
}

test("webview image messages validate exact bounded content", async function () {
  const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
  const data = Buffer.from("small-image").toString("base64");
  const valid = { type: "attachments.createImage", id: "image-one", name: "one.png", mediaType: "image/png", size: 11, data };
  assert.deepEqual(parseClientMessage(valid), valid);
  assert.equal(parseClientMessage({ ...valid, size: 12 }), undefined);
  assert.equal(parseClientMessage({ ...valid, mediaType: "image/svg+xml" }), undefined);
  assert.equal(parseClientMessage({ type: "attachment.open", id: "../escape" }), undefined);
  const restore = { type: "attachments.restore", attachments: [{ id: "image-one", name: "one.png", target: "history" }] };
  assert.deepEqual(parseClientMessage(restore), restore);
  assert.equal(parseClientMessage({ ...restore, attachments: [{ ...restore.attachments[0], target: "arbitrary" }] }), undefined);
});

test("runtime image construction rejects blob URLs and emits local paths", async function () {
  const { runtimeImages } = await importTypeScript("src/modules/chat/session-controller.ts");
  assert.throws(() => runtimeImages([{ id: "one", name: "one.png", kind: "image", uri: "blob:test", mediaType: "image/png" }]), /safe local file/);
  assert.deepEqual(runtimeImages([{ id: "one", name: "one.png", kind: "image", uri: "file:///tmp/one.png", mediaType: "image/png" }]), [{ path: "/tmp/one.png", mediaType: "image/png" }]);
});

test("preview rendering opens only host-owned attachment identifiers and drops blob persistence", async function () {
  const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  const panel = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  assert.match(script, /type: "attachment\.open", id: attachment\.id/);
  assert.match(script, /!item\.previewUri\?\.startsWith\("blob:"\)/);
  assert.match(script, /const \{ previewUri, pending, \.\.\.reference \} = attachment/);
  assert.match(script, /restoreImages\.push\(\{ id: item\.id, name: item\.name, target: "history" \}\)/);
  assert.match(script, /postMessage\(\{ type: "attachments\.restore", attachments: restoreImages \}\)/);
  assert.match(script, /function renderHistoryAttachments[\s\S]*type: "attachment\.open", id: attachment\.id/);
  assert.match(script, /const \{ previewUri, pending, \.\.\.persisted \} = attachment/);
  assert.match(panel, /executeCommand\("vscode\.open", uri\)/);
  assert.match(panel, /O_NOFOLLOW/);
  assert.match(panel, /localResourceRoots: uniqueUris/);
});

test("sent image history retains host files while releasing only the composer budget", async function () {
  const panel = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  const webview = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  assert.match(panel, /finally\(\(\) => \{[\s\S]*managed\.imageAttachments\.delete\(item\.id\)/);
  assert.doesNotMatch(panel, /finally\(\(\) => Promise\.all\(attachments[\s\S]*removeImageAttachment/);
  assert.match(webview, /attachments: submittedAttachments/);
  assert.match(webview, /case "attachments\.restored"/);
});

test("host image budget includes already staged images", async function () {
  const { canStageImage, MAX_IMAGE_COUNT, MAX_TOTAL_IMAGE_BYTES } = await importTypeScript("src/common/image-input.ts");
  assert.equal(canStageImage(MAX_IMAGE_COUNT - 1, MAX_TOTAL_IMAGE_BYTES - 1, 1), true);
  assert.equal(canStageImage(MAX_IMAGE_COUNT, 0, 1), false);
  assert.equal(canStageImage(0, MAX_TOTAL_IMAGE_BYTES - 1, 2), false);
  const panel = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  assert.match(panel, /let imageCount = managed\.imageAttachments\.size/);
  assert.match(panel, /if \(!canStageImage\(imageCount, imageBytes, content\.byteLength\)\)/);
  assert.match(panel, /createdImageIds\.map\(id => this\.removeImageAttachment/);
});

test("runtime adapter uses a versioned file contract for both submit and send", async function () {
  const source = await readFile(new URL("../../src/infrastructure/agent-factory/agent-client.ts", import.meta.url), "utf8");
  assert.match(source, /schemaVersion: "0\.1\.0", kind: "agent-input"/);
  assert.match(source, /this\.inputCommand\(\[\s*"submit"/);
  assert.match(source, /this\.inputCommand\(\[\s*"send"/);
  assert.match(source, /"--input-file", contractPath/);
  assert.match(source, /rm\(directory, \{ recursive: true, force: true \}\)/);
});

test("runtime adapter refuses image metadata downgrade when plugin lacks image transport", async function () {
  const { AgentFactoryClient } = await importTypeScript("src/infrastructure/agent-factory/agent-client.ts");
  const client = new AgentFactoryClient("/unused/exec.py", "/unused/project");
  const flags = { model: false, reasoning: false, fast: false, goal: false, images: false };
  client.capabilities = async () => ({ submit: flags, send: flags });
  client.command = async () => { throw new Error("image request must not reach an incompatible runtime"); };
  const image = [{ path: "/tmp/one.png", mediaType: "image/png" }];
  await assert.rejects(client.submit("main-test", "inspect", {}, image), /update.*plugin.*reload.*extension host/s);
  await assert.rejects(client.send("main-test", "inspect", {}, image), /update.*plugin.*reload.*extension host/s);
});
