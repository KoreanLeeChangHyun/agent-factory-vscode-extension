import assert from "node:assert/strict";
import { mkdtemp, mkdir, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { pathToFileURL, fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const output = await build({
  entryPoints: [new URL("../../src/infrastructure/vscode/chat-panel-manager.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs", target: "node18", external: ["vscode"]
});
function uri(path) {
  return { fsPath: path, path, toString: () => pathToFileURL(path).href };
}
const vscode = {
  Uri: { joinPath: (base, ...parts) => uri(join(base.fsPath, ...parts)) },
  workspace: { fs: { createDirectory: value => mkdir(value.fsPath, { recursive: true }), stat: value => stat(value.fsPath) } }
};
const module = { exports: {} };
runInNewContext(output.outputFiles[0].text, {
  module, exports: module.exports, Buffer, console, process, setTimeout, clearTimeout,
  global: { Date },
  require: name => name === "vscode" ? vscode : require(name)
});

test("image staging and restoration keep panel options stable and panel-scoped", async () => {
  const root = await mkdtemp(join(tmpdir(), "image-panel-"));
  try {
    const manager = new module.exports.ChatPanelManager(
      { globalStorageUri: uri(root) }, { localResourceRoots: [uri(join(root, "static"))] }, () => [], async () => { throw new Error("not needed"); }
    );
    const options = manager.webviewOptions("panel-one");
    assert.deepEqual(Array.from(options.localResourceRoots, value => value.fsPath), [join(root, "static"), join(root, "chat-images", "panel-one")]);
    assert.throws(() => manager.webviewOptions("../escape"), /scope is invalid/);
    const posted = [];
    const panel = { webview: {
      get options() { return options; },
      set options(_value) { assert.fail("Image preparation must not reload Webview options"); },
      asWebviewUri: value => value,
      async postMessage(message) { posted.push(message); }
    } };
    const content = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9XcAAAAASUVORK5CYII=", "base64");
    const managed = { panel, state: { panelId: "panel-one" }, imageAttachments: new Map() };
    for (const id of ["aa-first", "bb-second"]) {
      await manager.createImageAttachment(managed, { id, name: "image.png", mediaType: "image/png", size: content.length, data: content.toString("base64") });
    }
    assert.deepEqual(posted.map(value => value.type), ["attachments.add", "attachments.add"]);
    for (const message of posted) {
      const path = fileURLToPath(message.attachments[0].uri);
      assert.ok(path.startsWith(join(root, "chat-images", "panel-one") + "/"));
      assert.equal((await stat(path)).size, content.length);
    }
    await manager.restoreImageAttachments(managed, [
      { id: "aa-first", name: "first.png", target: "composer" },
      { id: "bb-second", name: "second.png", target: "history" }
    ]);
    assert.equal(posted.at(-1).type, "attachments.restored");
    assert.equal(posted.at(-1).attachments.length, 2);
    await manager.createImageAttachment(managed, { id: "invalid", name: "bad.png", mediaType: "image/png", size: 1, data: "AA==" });
    assert.deepEqual(posted.slice(-2).map(value => value.type), ["attachment.rejected", "host.notice"]);
    assert.equal(posted.at(-1).level, "error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
