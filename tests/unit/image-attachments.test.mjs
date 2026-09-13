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
});

test("runtime image construction rejects blob URLs and emits local paths", async function () {
  const { runtimeImages } = await importTypeScript("src/modules/chat/session-controller.ts");
  assert.throws(() => runtimeImages([{ id: "one", name: "one.png", kind: "image", uri: "blob:test", mediaType: "image/png" }]), /안전한 로컬 파일/);
  assert.deepEqual(runtimeImages([{ id: "one", name: "one.png", kind: "image", uri: "file:///tmp/one.png", mediaType: "image/png" }]), [{ path: "/tmp/one.png", mediaType: "image/png" }]);
});

test("preview rendering opens only host-owned attachment identifiers and drops blob persistence", async function () {
  const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
  const panel = await readFile(new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url), "utf8");
  assert.match(script, /type: "attachment\.open", id: attachment\.id/);
  assert.match(script, /!item\.previewUri\?\.startsWith\("blob:"\)/);
  assert.match(script, /const \{ previewUri, pending, \.\.\.reference \} = attachment/);
  assert.match(panel, /executeCommand\("vscode\.open", uri\)/);
  assert.match(panel, /O_NOFOLLOW/);
  assert.match(panel, /localResourceRoots: uniqueUris/);
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
