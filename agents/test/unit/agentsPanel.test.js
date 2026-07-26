"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  AGENTS_PANEL_VIEW_TYPE,
  createAgentsPanelManager,
} = require("../../src/agentsPanel");

function createFixture() {
  const panels = [];
  const received = [];
  const posted = [];
  let panelNumber = 0;

  const vscode = {
    ViewColumn: { Active: 1 },
    window: {
      createWebviewPanel(viewType, title, column, options) {
        const disposeListeners = [];
        const webview = {
          cspSource: "vscode-webview://agents-panel",
          html: "",
          onDidReceiveMessage(listener) {
            received.push(listener);
            return { dispose() {} };
          },
          postMessage(message) {
            posted.push(message);
            return Promise.resolve(true);
          },
        };
        const panel = {
          id: ++panelNumber,
          viewType,
          title,
          column,
          options,
          webview,
          revealCalls: [],
          reveal(target) {
            this.revealCalls.push(target);
          },
          onDidDispose(listener) {
            disposeListeners.push(listener);
            return { dispose() {} };
          },
          dispose() {
            for (const listener of disposeListeners.splice(0)) listener();
          },
        };
        panels.push(panel);
        return panel;
      },
    },
  };
  const controller = {
    postMessage: undefined,
    handled: [],
    setPostMessage(callback) {
      this.postMessage = callback;
    },
    handleMessage(message) {
      this.handled.push(message);
    },
  };

  return { controller, panels, posted, received, vscode };
}

test("Agents panel manager creates one editor panel and reveals it on repeat open", () => {
  const fixture = createFixture();
  const manager = createAgentsPanelManager({
    vscode: fixture.vscode,
    controller: fixture.controller,
    createNonce: () => "panel-nonce",
  });

  const first = manager.open();
  const second = manager.open();

  assert.equal(first, second);
  assert.equal(fixture.panels.length, 1);
  assert.equal(first.viewType, AGENTS_PANEL_VIEW_TYPE);
  assert.equal(first.title, "Agent Factory Agents");
  assert.equal(first.column, fixture.vscode.ViewColumn.Active);
  assert.deepEqual(first.options, {
    enableScripts: true,
    localResourceRoots: [],
    retainContextWhenHidden: false,
  });
  assert.deepEqual(first.revealCalls, [fixture.vscode.ViewColumn.Active]);
  assert.match(first.webview.html, /nonce="panel-nonce"/);
});

test("Agents panel manager reconnects messaging and recreates after disposal", async () => {
  const fixture = createFixture();
  const manager = createAgentsPanelManager({
    vscode: fixture.vscode,
    controller: fixture.controller,
    createNonce: () => "panel-nonce",
  });

  const first = manager.open();
  await fixture.controller.postMessage({ type: "chat.snapshot" });
  fixture.received[0]({ type: "chat.ready" });
  first.dispose();
  const second = manager.open();

  assert.deepEqual(fixture.posted, [{ type: "chat.snapshot" }]);
  assert.deepEqual(fixture.controller.handled, [{ type: "chat.ready" }]);
  assert.notEqual(first, second);
  assert.equal(fixture.panels.length, 2);
});
