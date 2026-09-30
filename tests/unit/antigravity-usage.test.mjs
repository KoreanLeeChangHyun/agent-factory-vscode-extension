import assert from "node:assert/strict";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const { readAntigravityUsage } = await importTypeScript("src/infrastructure/agent-factory/antigravity-usage.ts");

// Recorded from `agy --output-format json -p=/usage` (agy 1.2.13, Google AI Pro).
const RECORDED = { conversation_id: "", status: "SUCCESS", command: { name: "usage", data: { groups: [
  { name: "Gemini Models", buckets: [
    { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.8843996524810791, reset_time: "2026-10-05T12:59:25Z" },
    { id: "gemini-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-09-30T22:36:02Z" }] },
  { name: "Claude and GPT models", buckets: [
    { id: "3p-weekly", window: "weekly", remaining_fraction: 0.8445900082588196, reset_time: "2026-10-05T13:01:47Z" },
    { id: "3p-5h", window: "5h", remaining_fraction: 0.9428536295890808, reset_time: "2026-09-30T20:15:25Z" }] }
] } } };

test("agy /usage becomes one account per quota pool with used percent and reset seconds", async () => {
  const calls = [];
  const accounts = await readAntigravityUsage("agy", async (executable, args) => {
    calls.push([executable, ...args]);
    return { stdout: JSON.stringify(RECORDED) };
  });
  assert.deepEqual(calls, [["agy", "--output-format", "json", "-p=/usage"]]);
  assert.deepEqual(accounts, [
    { provider: "antigravity-gemini", weeklyUsedPercent: 11.6, weeklyResetsAt: Date.parse("2026-10-05T12:59:25Z") / 1000,
      fiveHourUsedPercent: 0, fiveHourResetsAt: Date.parse("2026-09-30T22:36:02Z") / 1000 },
    { provider: "antigravity-claude-gpt", weeklyUsedPercent: 15.5, weeklyResetsAt: Date.parse("2026-10-05T13:01:47Z") / 1000,
      fiveHourUsedPercent: 5.7, fiveHourResetsAt: Date.parse("2026-09-30T20:15:25Z") / 1000 }
  ]);
});

test("a missing, signed-out or changed agy reports nothing instead of failing", async () => {
  assert.deepEqual(await readAntigravityUsage("agy", async () => { throw new Error("ENOENT"); }), []);
  assert.deepEqual(await readAntigravityUsage("agy", async () => ({ stdout: "not json" })), []);
  assert.deepEqual(await readAntigravityUsage("agy", async () => ({ stdout: JSON.stringify({ command: { name: "credits" } }) })), []);
  const unknown = { command: { name: "usage", data: { groups: [{ name: "Future pool", buckets: [{ id: "x-weekly", window: "weekly", remaining_fraction: 0.5 }] }] } } };
  assert.deepEqual(await readAntigravityUsage("agy", async () => ({ stdout: JSON.stringify(unknown) })), []);
  const invalid = { command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ id: "gemini-weekly", window: "weekly", remaining_fraction: 7 }] }] } } };
  assert.deepEqual(await readAntigravityUsage("agy", async () => ({ stdout: JSON.stringify(invalid) })), []);
});
