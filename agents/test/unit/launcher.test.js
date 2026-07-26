"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  EmptyLauncherProvider,
  LAUNCHER_VIEW_ID,
  registerLauncher,
} = require("../../src/launcher");

test("launcher registers one empty native TreeDataProvider", () => {
  const subscriptions = [];
  const registration = { dispose() {} };
  let registered;
  const vscode = {
    window: {
      registerTreeDataProvider(viewId, provider) {
        registered = { provider, viewId };
        return registration;
      },
    },
  };

  const provider = registerLauncher(vscode, { subscriptions });

  assert.ok(provider instanceof EmptyLauncherProvider);
  assert.equal(registered.viewId, LAUNCHER_VIEW_ID);
  assert.equal(registered.provider, provider);
  assert.deepEqual(provider.getChildren(), []);
  assert.deepEqual(subscriptions, [registration]);
});
