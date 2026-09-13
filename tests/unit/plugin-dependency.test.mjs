import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function importTypeScript(relativePath, mockExtensionImports = false) {
  const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
  const plugins = mockExtensionImports ? [{
    name: "activation-test-mocks",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "mock" }));
      buildApi.onResolve({ filter: /core\/bootstrap$/ }, () => ({ path: "bootstrap", namespace: "mock" }));
      buildApi.onResolve({ filter: /plugin-dependency$/ }, () => ({ path: "dependency", namespace: "mock" }));
      buildApi.onLoad({ filter: /.*/, namespace: "mock" }, (args) => {
        if (args.path === "vscode") return { contents: "export const ProgressLocation = { Notification: 15 }; export const window = {};" };
        if (args.path === "bootstrap") return { contents: "export function bootstrap() {}" };
        return { contents: "export async function ensureAgentFactoryPlugin() {}" };
      });
    }
  }] : [];
  const output = await build({
    entryPoints: [sourcePath],
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node18",
    write: false,
    plugins
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
}

const dependency = await importTypeScript("src/infrastructure/agent-factory/plugin-dependency.ts");

test("release metadata and installation guidance stay coupled", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const version = packageJson.version;

  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[""].version, version);
  assert.ok(readme.includes(`Extension \`${version}\``));
  assert.ok(readme.includes(`${version}+codex.<token>`));
  for (const notice of [
    "installed and enabled",
    "identical semantic base version",
    "official `agent-factory` marketplace",
    "attempts one compatible plugin installation",
    "activation blocks",
    "fully installable and usable without this extension",
    "released together",
    "does not contain or bundle"
  ]) assert.ok(readme.includes(notice), `README missing release notice: ${notice}`);
  assert.ok(readme.includes("codex plugin marketplace add KoreanLeeChangHyun/agent-factory-codex-plugin --ref main"));
  assert.ok(readme.includes("codex plugin marketplace upgrade agent-factory"));
  assert.ok(readme.includes("codex plugin add agent-factory@agent-factory"));
});

function record(overrides = {}) {
  return {
    pluginId: "personal@agent-factory",
    name: "agent-factory",
    marketplaceName: "personal",
    version: "1.0.2+codex.test",
    installed: false,
    enabled: false,
    ...overrides
  };
}

function json(value) {
  return { stdout: JSON.stringify(value) };
}

function queuedRunner(results) {
  const calls = [];
  const runner = async (command, args, options) => {
    calls.push({ command, args: [...args], options });
    const next = results.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected process call");
    return next;
  };
  return { calls, runner };
}

test("compatible installed plugin performs no add and accepts a cachebuster suffix", async () => {
  const process = queuedRunner([json([record({ installed: true, enabled: true })])]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.equal(dependency.semanticBase("1.0.2+codex.20260913"), "1.0.2");
  assert.deepEqual(process.calls.map((call) => call.args), [["plugin", "list", "--available", "--json"]]);
  assert.equal(process.calls[0].command, "codex");
  assert.ok(process.calls[0].options.timeout > 0);
  assert.ok(process.calls[0].options.maxBuffer > 0);
});

test("missing or incompatible installed plugin adds a compatible plugin and verifies it", async () => {
  const candidate = record({ pluginId: "team@agent-factory", marketplaceName: "team" });
  const process = queuedRunner([
    json([record({ version: "1.0.1", installed: true, enabled: true }), candidate]),
    json({ installed: true }),
    json([{ ...candidate, installed: true, enabled: true }])
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2+extension.build", process.runner);
  assert.deepEqual(process.calls.map((call) => call.args), [
    ["plugin", "list", "--available", "--json"],
    ["plugin", "add", "team@agent-factory", "--json"],
    ["plugin", "list", "--available", "--json"]
  ]);
});

test("candidate selection prefers marketplace agent-factory and is otherwise deterministic", async () => {
  const official = record({ pluginId: "official@agent-factory", marketplaceName: "agent-factory" });
  const process = queuedRunner([
    json([record({ pluginId: "z@agent-factory", marketplaceName: "zeta" }), official, record({ pluginId: "a@agent-factory", marketplaceName: "alpha" })]),
    json({ installed: true }),
    json([{ ...official, installed: true, enabled: true }])
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.deepEqual(process.calls[1].args, ["plugin", "add", "official@agent-factory", "--json"]);

  const alphabetical = queuedRunner([
    json([record({ pluginId: "z@agent-factory", marketplaceName: "zeta" }), record({ pluginId: "a@agent-factory", marketplaceName: "alpha" })]),
    json({ installed: true }),
    json([record({ pluginId: "a@agent-factory", marketplaceName: "alpha", installed: true, enabled: true })])
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", alphabetical.runner);
  assert.deepEqual(alphabetical.calls[1].args, ["plugin", "add", "a@agent-factory", "--json"]);
});

test("no compatible available plugin fails without add", async () => {
  const process = queuedRunner([json([record({ version: "1.0.1", installed: true, enabled: true })])]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /공식 marketplace/);
  assert.equal(process.calls.length, 1);
});

test("add or recheck failure blocks activation", async (t) => {
  await t.test("malformed add output", async () => {
    const process = queuedRunner([json([record()]), { stdout: "[]" }]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /JSON 객체/);
    assert.equal(process.calls.length, 2);
  });
  await t.test("plugin remains disabled after add", async () => {
    const process = queuedRunner([json([record()]), json({ installed: true }), json([record({ installed: true, enabled: false })])]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /활성 상태/);
  });
});

test("malformed, oversized, and failed command output blocks", async (t) => {
  await t.test("malformed JSON", async () => {
    const process = queuedRunner([{ stdout: "{" }]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /올바른 JSON/);
  });
  await t.test("invalid record", async () => {
    const process = queuedRunner([json([{ name: "agent-factory" }])]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /레코드 형식/);
  });
  await t.test("oversized output", async () => {
    const process = queuedRunner([{ stdout: " ".repeat(256 * 1024 + 1) }]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /크기를 초과/);
  });
  await t.test("failed command", async () => {
    const process = queuedRunner([new Error("spawn failed")]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /실행 환경/);
  });
});

test("activation bootstraps only after dependency success and reports one failure", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.2" } } };
  const events = [];
  const services = {
    ensurePlugin: async (version) => { events.push(`ensure:${version}`); },
    bootstrap: () => { events.push("bootstrap"); },
    withProgress: async (options, task) => {
      events.push(`progress:${options.location}:${options.cancellable}`);
      return task({}, {});
    },
    showErrorMessage: async (message) => { events.push(`error:${message}`); }
  };
  await activate(context, services);
  assert.deepEqual(events, ["progress:15:false", "ensure:1.0.2", "bootstrap"]);

  events.length = 0;
  services.ensurePlugin = async () => { throw new Error("dependency unavailable"); };
  await activate(context, services);
  assert.equal(events.length, 2);
  assert.match(events[1], /^error:Agent Factory를 시작하지 못했습니다\. dependency unavailable$/);
  assert.ok(!events.includes("bootstrap"));
});
