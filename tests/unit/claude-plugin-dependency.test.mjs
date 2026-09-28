import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const { ensureAgentFactoryClaudePlugin } = await importTypeScript("src/infrastructure/agent-factory/claude-plugin-dependency.ts");
const { locateAgentFactoryExec } = await importTypeScript("src/infrastructure/agent-factory/plugin-locator.ts");

function fakeClaude({ installed, marketplaces = [], available = "1.0.17" }) {
  const calls = [];
  const state = { installed, marketplaces };
  const runner = async (_executable, args) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === "plugin list --json") return { stdout: JSON.stringify(state.installed ? [{ id: "agent-factory@agent-factory", version: state.installed, enabled: true }] : []) };
    if (command === "plugin list --available --json") return { stdout: JSON.stringify({ installed: [], available: [{ pluginId: "agent-factory@agent-factory", version: available }] }) };
    if (command === "plugin marketplace list --json") return { stdout: JSON.stringify(state.marketplaces) };
    if (command.startsWith("plugin marketplace add")) { state.marketplaces = [{ name: "agent-factory", repo: args[3] }]; return { stdout: "" }; }
    if (command.startsWith("plugin install") || command.startsWith("plugin update")) { state.installed = available; return { stdout: "" }; }
    return { stdout: "" };
  };
  return { runner, calls };
}

test("a matching installed Claude plugin needs no changes", async () => {
  const { runner, calls } = fakeClaude({ installed: "1.0.17" });
  await ensureAgentFactoryClaudePlugin("1.0.17", runner);
  assert.deepEqual(calls, ["plugin list --json"]);
});

test("a missing plugin registers the official marketplace and installs", async () => {
  const { runner, calls } = fakeClaude({});
  await ensureAgentFactoryClaudePlugin("1.0.17", runner);
  assert.ok(calls.includes("plugin marketplace add KoreanLeeChangHyun/agent-factory-claude-plugin"));
  assert.ok(calls.includes("plugin marketplace update agent-factory"));
  assert.ok(calls.includes("plugin install agent-factory@agent-factory"));
});

test("an older plugin is updated after refreshing the catalog", async () => {
  const { runner, calls } = fakeClaude({ installed: "1.0.16", marketplaces: [{ name: "agent-factory", repo: "KoreanLeeChangHyun/agent-factory-claude-plugin" }] });
  await ensureAgentFactoryClaudePlugin("1.0.17", runner);
  assert.deepEqual(calls.filter(call => !call.startsWith("plugin list")), ["plugin marketplace list --json", "plugin marketplace update agent-factory", "plugin update agent-factory@agent-factory"]);
});

test("a foreign marketplace name and a missing version fail without changes", async () => {
  const foreign = fakeClaude({ marketplaces: [{ name: "agent-factory", repo: "someone/else" }] });
  await assert.rejects(ensureAgentFactoryClaudePlugin("1.0.17", foreign.runner), /different source/);
  assert.ok(!foreign.calls.some(call => /install|add|update/.test(call)));
  const stale = fakeClaude({ available: "1.0.16" });
  await assert.rejects(ensureAgentFactoryClaudePlugin("1.0.17", stale.runner), /does not offer plugin version 1\.0\.17/);
  assert.ok(!stale.calls.some(call => call.startsWith("plugin install")));
});

test("the runtime is located in Claude Code's plugin cache when Codex has none", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-claude-cache-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plugin = join(root, "claude", "plugins/cache/agent-factory/agent-factory/1.0.17");
  const exec = join(plugin, "scripts/exec.py");
  await mkdir(dirname(exec), { recursive: true });
  await mkdir(join(plugin, ".claude-plugin"));
  await writeFile(exec, "# runtime");
  await writeFile(join(plugin, ".claude-plugin/plugin.json"), JSON.stringify({ name: "agent-factory", version: "1.0.17" }));
  const environment = { CODEX_HOME: join(root, "missing-codex"), CLAUDE_CONFIG_DIR: join(root, "claude") };
  assert.deepEqual(await locateAgentFactoryExec({ environment, requiredVersion: "1.0.17" }), { available: true, execPath: exec });
  assert.equal((await locateAgentFactoryExec({ environment, requiredVersion: "1.0.18" })).available, false);
});
