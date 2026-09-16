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
  const normalizedReadme = readme.replace(/\s+/g, " ");
  const version = packageJson.version;

  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[""].version, version);
  assert.ok(readme.includes(`Extension \`${version}\``));
  assert.ok(readme.includes(`${version}+codex.<token>`));
  for (const notice of [
    "installed and enabled",
    "identical semantic base version",
    "official `agent-factory` marketplace",
    "attempt one compatible plugin installation",
    "activation blocks",
    "fully installable and usable without this extension",
    "released together",
    "does not contain or bundle"
  ]) assert.ok(normalizedReadme.includes(notice), `README missing release notice: ${notice}`);
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

function currentList(installed = [], available = []) {
  return { installed, available };
}

const officialMarketplace = {
  name: "agent-factory",
  marketplaceSource: {
    sourceType: "git",
    source: "https://github.com/KoreanLeeChangHyun/agent-factory-codex-plugin.git"
  }
};
const marketplaceList = (...marketplaces) => json({ marketplaces });

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

test("current CLI schema activates a compatible installed plugin without requesting available catalog", async () => {
  const process = queuedRunner([json(currentList([record({ installed: true, enabled: true })]))]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.equal(dependency.semanticBase("1.0.2+codex.20260913"), "1.0.2");
  assert.deepEqual(process.calls.map((call) => call.args), [["plugin", "list", "--json"]]);
  assert.equal(process.calls[0].command, "codex");
  assert.ok(process.calls[0].options.timeout > 0);
  assert.ok(process.calls[0].options.maxBuffer > 0);
});

test("installation-needed path reads a large current-schema available catalog and verifies without it", async () => {
  const candidate = record({
    pluginId: "team@agent-factory",
    marketplaceName: "team",
    catalogPadding: "x".repeat(300 * 1024)
  });
  const installedCandidate = record({
    pluginId: "team@agent-factory",
    marketplaceName: "team",
    installed: true,
    enabled: true
  });
  const process = queuedRunner([
    json(currentList([record({ version: "1.0.1", installed: true, enabled: true })])),
    marketplaceList(officialMarketplace),
    json(currentList([], [candidate])),
    json({ installed: true }),
    json(currentList([installedCandidate]))
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2+extension.build", process.runner);
  assert.deepEqual(process.calls.map((call) => call.args), [
    ["plugin", "list", "--json"],
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--available", "--json"],
    ["plugin", "add", "team@agent-factory", "--json"],
    ["plugin", "list", "--json"]
  ]);
  assert.ok(process.calls[2].options.maxBuffer > 300 * 1024);
  assert.ok(process.calls[2].options.maxBuffer > process.calls[0].options.maxBuffer);
});

test("candidate selection prefers marketplace agent-factory and is otherwise deterministic", async () => {
  const official = record({ pluginId: "official@agent-factory", marketplaceName: "agent-factory" });
  const process = queuedRunner([
    json(currentList()),
    marketplaceList(officialMarketplace),
    json(currentList([], [record({ pluginId: "z@agent-factory", marketplaceName: "zeta" }), official, record({ pluginId: "a@agent-factory", marketplaceName: "alpha" })])),
    json({ installed: true }),
    json(currentList([{ ...official, installed: true, enabled: true }]))
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.deepEqual(process.calls[3].args, ["plugin", "add", "official@agent-factory", "--json"]);

  const alphabetical = queuedRunner([
    json(currentList()),
    marketplaceList(officialMarketplace),
    json(currentList([], [record({ pluginId: "z@agent-factory", marketplaceName: "zeta" }), record({ pluginId: "a@agent-factory", marketplaceName: "alpha" })])),
    json({ installed: true }),
    json(currentList([record({ pluginId: "a@agent-factory", marketplaceName: "alpha", installed: true, enabled: true })]))
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", alphabetical.runner);
  assert.deepEqual(alphabetical.calls[3].args, ["plugin", "add", "a@agent-factory", "--json"]);
});

test("no compatible available plugin fails without add", async () => {
  const process = queuedRunner([
    json(currentList([record({ version: "1.0.1", installed: true, enabled: true })])),
    marketplaceList(officialMarketplace),
    json(currentList())
  ]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /exact version/);
  assert.equal(process.calls.length, 3);
});

test("add or recheck failure blocks activation", async (t) => {
  await t.test("malformed add output", async () => {
    const process = queuedRunner([json(currentList()), marketplaceList(officialMarketplace), json(currentList([], [record()])), { stdout: "[]" }]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /JSON object/);
    assert.equal(process.calls.length, 4);
  });
  await t.test("plugin remains disabled after add", async () => {
    const process = queuedRunner([
      json(currentList()),
      marketplaceList(officialMarketplace),
    json(currentList([], [record()])),
      json({ installed: true }),
      json(currentList([record({ installed: true, enabled: false })]))
    ]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /is active/);
  });
});

test("malformed, oversized, and failed command output blocks", async (t) => {
  await t.test("malformed JSON", async () => {
    const process = queuedRunner([{ stdout: "{" }]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /valid JSON/);
  });
  await t.test("invalid record", async () => {
    const process = queuedRunner([json(currentList([{ name: "agent-factory" }]))]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /record .*invalid format/);
  });
  await t.test("oversized output", async () => {
    const process = queuedRunner([{ stdout: " ".repeat(256 * 1024 + 1) }]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /exceeded the size limit/);
  });
  await t.test("missing executable", async () => {
    const error = Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" });
    const process = queuedRunner([error]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /executable was not found/);
  });
  await t.test("timeout", async () => {
    const error = Object.assign(new Error("timed out"), { killed: true });
    const process = queuedRunner([error]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /timed out/);
  });
  await t.test("output limit", async () => {
    const error = Object.assign(new Error("stdout maxBuffer length exceeded"), {
      code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    });
    const process = queuedRunner([error]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /exceeded the size limit/);
  });
  await t.test("other command failure", async () => {
    const process = queuedRunner([new Error("spawn failed")]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /execution environment/);
  });
});

test("legacy top-level and plugins-array schemas remain compatible", async () => {
  const topLevel = queuedRunner([json([record({ installed: true, enabled: true })])]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", topLevel.runner);

  const pluginsArray = queuedRunner([json({ plugins: [record({ installed: true, enabled: true })] })]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", pluginsArray.runner);
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
  await activate({ extension: context.extension }, services);
  assert.equal(events.length, 2);
  assert.match(events[1], /^error:Unable to start Agent Factory\. dependency unavailable/);
  assert.ok(!events.includes("bootstrap"));
});

test("first activation registers missing official source, installs exact version, then confirms it", async () => {
  const candidate = record({ pluginId: "agent-factory@agent-factory", marketplaceName: "agent-factory" });
  const process = queuedRunner([
    json(currentList()), marketplaceList(), json({ added: true }), marketplaceList(officialMarketplace),
    json(currentList([], [candidate])), json({ installed: true }),
    json(currentList([{ ...candidate, installed: true, enabled: true }]))
  ]);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.deepEqual(process.calls.map(({ args }) => args), [
    ["plugin", "list", "--json"],
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "marketplace", "add", "KoreanLeeChangHyun/agent-factory-codex-plugin", "--ref", "main", "--json"],
    ["plugin", "marketplace", "list", "--json"],
    ["plugin", "list", "--available", "--json"],
    ["plugin", "add", "agent-factory@agent-factory", "--json"],
    ["plugin", "list", "--json"]
  ]);
});

test("conflicting or unconfirmed official marketplace is never overwritten", async () => {
  for (const source of [undefined, { sourceType: "local", source: "/workspace/marketplace" },
    { sourceType: "git", source: "https://github.com/other/repo.git" }]) {
    const process = queuedRunner([json(currentList()), marketplaceList({ name: "agent-factory", marketplaceSource: source })]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /name conflict/);
    assert.equal(process.calls.length, 2);
  }
});

test("registration failure can be retried and successful registration is not repeated", async () => {
  const process = queuedRunner([
    json(currentList()), marketplaceList(), new Error("offline"),
    json(currentList()), marketplaceList(officialMarketplace), json(currentList([], [record()])),
    json({ installed: true }), json(currentList([record({ installed: true, enabled: true })]))
  ]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /Register official/);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.equal(process.calls.filter(({ args }) => args[1] === "marketplace" && args[2] === "add").length, 1);
});

test("missing registration confirmation and wrong post-install version block success", async () => {
  const missing = queuedRunner([json(currentList()), marketplaceList(), json({ added: true }), marketplaceList()]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", missing.runner), /confirm.*registration/);
  const wrong = queuedRunner([
    json(currentList()), marketplaceList(officialMarketplace), json(currentList([], [record()])),
    json({ installed: true }), json(currentList([record({ version: "1.0.3", installed: true, enabled: true })]))
  ]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", wrong.runner), /active after installation/);
});

test("concurrent dependency checks share one installation and later calls recheck", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const process = queuedRunner([
    json(currentList()), marketplaceList(officialMarketplace), json(currentList([], [record()])),
    json({ installed: true }), json(currentList([record({ installed: true, enabled: true })])),
    json(currentList([record({ installed: true, enabled: true })]))
  ]);
  const runner = async (...args) => { await gate; return process.runner(...args); };
  const first = dependency.ensureAgentFactoryPlugin("1.0.2", runner);
  const second = dependency.ensureAgentFactoryPlugin("1.0.2", runner);
  release();
  await Promise.all([first, second]);
  assert.equal(process.calls.length, 5);
  await dependency.ensureAgentFactoryPlugin("1.0.2", runner);
  assert.equal(process.calls.length, 6);
});

test("activation Retry reruns dependencies and concurrent activation bootstraps once", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.2" } } };
  let attempts = 0;
  let bootstraps = 0;
  let notifications = 0;
  const services = {
    ensurePlugin: async () => { if (++attempts === 1) throw new Error("Codex CLI executable was not found"); },
    bootstrap: () => { bootstraps++; },
    withProgress: async (_, task) => task(),
    showErrorMessage: async (message, action) => {
      notifications++;
      assert.match(message, /workspace extension host/);
      assert.equal(action, "Retry");
      return "Retry";
    }
  };
  await Promise.all([activate(context, services), activate(context, services)]);
  await activate(context, services);
  assert.equal(attempts, 2);
  assert.equal(notifications, 1);
  assert.equal(bootstraps, 1);
});

test("dismissing dependency error leaves activation retryable without bootstrap", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.2" } } };
  let bootstraps = 0;
  const services = {
    ensurePlugin: async () => { throw new Error("installation failed"); },
    bootstrap: () => { bootstraps++; },
    withProgress: async (_, task) => task(),
    showErrorMessage: async () => undefined
  };
  await activate(context, services);
  assert.equal(bootstraps, 0);
  services.ensurePlugin = async () => {};
  await activate(context, services);
  assert.equal(bootstraps, 1);
});

test("a newer catalog version is never installed as an exact-version fallback", async () => {
  const process = queuedRunner([
    json(currentList()), marketplaceList(officialMarketplace),
    json(currentList([], [record({ version: "1.0.3+codex.new" })]))
  ]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /exact version/);
  assert.equal(process.calls.length, 3);
});

test("installation command failure is surfaced and a later retry reruns installation", async () => {
  const process = queuedRunner([
    json(currentList()), marketplaceList(officialMarketplace), json(currentList([], [record()])), new Error("network unavailable"),
    json(currentList()), marketplaceList(officialMarketplace), json(currentList([], [record()])),
    json({ installed: true }), json(currentList([record({ installed: true, enabled: true })]))
  ]);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /plugin installation failed/);
  await dependency.ensureAgentFactoryPlugin("1.0.2", process.runner);
  assert.equal(process.calls.filter(({ args }) => args[1] === "add").length, 2);
});

test("malformed marketplace list blocks registration", async () => {
  for (const output of [json({}), json({ marketplaces: [null] }), { stdout: "{" }]) {
    const process = queuedRunner([json(currentList()), output]);
    await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", process.runner), /marketplace list/);
    assert.equal(process.calls.length, 2);
  }
});
