import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const { ensureAgentFactoryAntigravityPlugin, isAntigravityAvailable } =
  await importTypeScript("src/infrastructure/agent-factory/antigravity-plugin-dependency.ts");
const REPOSITORY = "https://github.com/KoreanLeeChangHyun/agent-factory-antigravity-plugin";

async function withHome(run) {
  const home = await mkdtemp(join(tmpdir(), "af-agy-plugin-"));
  try { await run(home); } finally { await rm(home, { recursive: true, force: true }); }
}

async function writeManifest(home, version, name = "agent-factory") {
  const directory = join(home, ".gemini", "config", "plugins", "agent-factory");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "plugin.json"), JSON.stringify({ name, version }));
}

function fakeAgy(home, published) {
  const calls = [];
  const runner = async (_executable, args) => {
    calls.push(args.join(" "));
    if (args[0] === "plugin" && args[1] === "install") await writeManifest(home, published);
    return { stdout: "" };
  };
  return { runner, calls };
}

test("a matching installed Antigravity plugin needs no changes", () => withHome(async home => {
  await writeManifest(home, "1.0.19");
  const { runner, calls } = fakeAgy(home, "1.0.19");
  await ensureAgentFactoryAntigravityPlugin("1.0.19", runner, { home });
  assert.deepEqual(calls, []);
}));

test("a missing or outdated plugin is installed from the official repository", () => withHome(async home => {
  const { runner, calls } = fakeAgy(home, "1.0.19");
  await ensureAgentFactoryAntigravityPlugin("1.0.19", runner, { home });
  assert.deepEqual(calls, [`plugin install ${REPOSITORY}`]);
  await writeManifest(home, "1.0.18");
  await ensureAgentFactoryAntigravityPlugin("1.0.19", runner, { home });
  assert.equal(calls.length, 2);
}));

test("a repository without the required version is reported, not accepted", () => withHome(async home => {
  const { runner } = fakeAgy(home, "1.0.18");
  await assert.rejects(ensureAgentFactoryAntigravityPlugin("1.0.19", runner, { home }), /1\.0\.19/);
}));

test("a same-named plugin from elsewhere is never taken as ours", () => withHome(async home => {
  await writeManifest(home, "1.0.19", "other-plugin");
  const { runner, calls } = fakeAgy(home, "1.0.19");
  await ensureAgentFactoryAntigravityPlugin("1.0.19", runner, { home });
  assert.deepEqual(calls, [`plugin install ${REPOSITORY}`]);
}));

test("install failures surface the CLI error", () => withHome(async home => {
  const runner = async () => { throw Object.assign(new Error("exit 1"), { stderr: "network down" }); };
  await assert.rejects(ensureAgentFactoryAntigravityPlugin("1.0.19", runner, { home }), /network down/);
}));

test("agy is optional: a missing or unrecognized CLI is simply unavailable", async () => {
  assert.equal(await isAntigravityAvailable("agy", async () => ({ stdout: "1.2.13\n" })), true);
  assert.equal(await isAntigravityAvailable("agy", async () => { throw new Error("ENOENT"); }), false);
  assert.equal(await isAntigravityAvailable("agy", async () => ({ stdout: "unexpected" })), false);
});
