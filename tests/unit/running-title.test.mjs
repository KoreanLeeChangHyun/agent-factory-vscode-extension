import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const output = await build({
  entryPoints: [new URL("../../src/infrastructure/vscode/running-title.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "cjs"
});

function harness() {
  const timers = new Map();
  let id = 0;
  const module = { exports: {} };
  runInNewContext(output.outputFiles[0].text, {
    module, exports: module.exports,
    setInterval(callback) { timers.set(++id, callback); return id; },
    clearInterval(timer) { timers.delete(timer); }
  });
  return { RunningTitle: module.exports.RunningTitle, timers, tick() { for (const callback of timers.values()) callback(); } };
}

test("running titles rotate, preserve renamed titles and restore on terminal state", () => {
  const { RunningTitle, timers, tick } = harness();
  let name = "Main Agent", title, frame;
  const spinner = new RunningTitle(() => name, (value, marker) => { title = value; frame = marker; });
  spinner.setRunning(true);
  const initial = frame;
  assert.equal(title, "Main Agent");
  tick();
  assert.notEqual(frame, initial);
  for (let i = 0; i < 5; i++) tick();
  assert.equal(frame, initial);
  spinner.setRunning(true);
  assert.equal(timers.size, 1);
  name = "New name";
  spinner.refresh();
  assert.equal(title, "New name");
  spinner.setRunning(false);
  assert.equal(title, name);
  assert.equal(frame, undefined);
  assert.equal(timers.size, 0);
  tick();
  assert.equal(title, name);
  assert.equal(frame, undefined);
  spinner.setRunning(true);
  assert.equal(timers.size, 1);
  spinner.dispose();
  assert.equal(timers.size, 0);
});

test("closing one panel stops its animation without affecting another", () => {
  const { RunningTitle, timers, tick } = harness();
  let first, second;
  const a = new RunningTitle(() => "A", (_value, frame) => { first = frame; });
  const b = new RunningTitle(() => "B", (_value, frame) => { second = frame; });
  a.setRunning(true);
  b.setRunning(true);
  a.dispose();
  const previousFirst = first, previousSecond = second;
  tick();
  assert.equal(first, previousFirst);
  assert.notEqual(second, previousSecond);
  assert.equal(timers.size, 1);
  b.dispose();
});
