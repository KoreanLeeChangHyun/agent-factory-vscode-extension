import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFile, mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import test from "node:test";

async function importTypeScript(relativePath, mockExtensionImports = false) {
  const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
  const plugins = mockExtensionImports ? [{
    name: "activation-test-mocks",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "mock" }));
      buildApi.onResolve({ filter: /core\/bootstrap$/ }, () => ({ path: "bootstrap", namespace: "mock" }));
      buildApi.onResolve({ filter: /plugin-dependency$/ }, (args) => ({ path: /claude-plugin-dependency$/.test(args.path) ? "claude-dependency" : /antigravity-plugin-dependency$/.test(args.path) ? "antigravity-dependency" : "dependency", namespace: "mock" }));
      buildApi.onLoad({ filter: /.*/, namespace: "mock" }, (args) => {
        if (args.path === "vscode") return { contents: "export const ExtensionMode = { Production: 1, Development: 2, Test: 3 }; export const ProgressLocation = { Notification: 15 }; export const window = {};" };
        if (args.path === "bootstrap") return { contents: "export function bootstrap() {}" };
        if (args.path === "claude-dependency") return { contents: "export async function ensureAgentFactoryClaudePlugin() {} export async function installedClaudePluginVersion() { return undefined; }" };
        if (args.path === "antigravity-dependency") return { contents: "export async function ensureAgentFactoryAntigravityPlugin() {} export async function isAntigravityAvailable() { return false; } export async function installedAntigravityPluginVersion() { return undefined; }" };
        return { contents: "export async function ensureAgentFactoryPlugin() {} export function semanticBase(value) { return String(value).split('+')[0]; } export async function installedCodexPluginVersion() { return undefined; }" };
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
const codexSetup = await importTypeScript("src/infrastructure/agent-factory/codex-plugin-setup.ts");

test("Codex setup uses a matching local runtime without querying the remote plugin catalog", async () => {
  const calls = [];
  await codexSetup.ensureAgentFactoryCodexRuntime("1.0.2+extension.build", async options => {
    calls.push(["locate", options.requiredVersion]);
    return { available: true, execPath: "/cache/agent-factory/skills/agent/scripts/exec.py" };
  }, async version => calls.push(["repair", version]));
  assert.deepEqual(calls, [["locate", "1.0.2+extension.build"]]);
});

test("Codex setup runs the existing repair flow only when the local runtime is missing", async () => {
  const calls = [];
  await codexSetup.ensureAgentFactoryCodexRuntime("1.0.2", async options => {
    calls.push(["locate", options.requiredVersion]);
    return { available: false, diagnostic: "missing" };
  }, async version => calls.push(["repair", version]));
  assert.deepEqual(calls, [["locate", "1.0.2"], ["repair", "1.0.2"]]);
});

test("development activation uses live local sources without installation and fails closed", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-dev-plugin-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previous = process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT;
  process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT;
    else process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT = previous;
  });
  const { activate } = await importTypeScript("src/extension.ts", true);
  let bootstraps = 0;
  const errors = [];
  const services = {
    ensurePlugin: async () => { assert.fail("development must not install a plugin"); },
    bootstrap: () => { bootstraps++; },
    withProgress: async (_, task) => task(),
    showErrorMessage: async (message) => { errors.push(message); }
  };
  const context = () => ({ extensionMode: 2, extension: { packageJSON: { version: "1.0.2" } } });
  await activate(context(), services);
  assert.equal(bootstraps, 0);
  for (const file of [".codex-plugin/plugin.json", "skills/agent/scripts/exec.py",
    ...["agent", "convention", "document"].map(name => `skills/${name}/SKILL.md`)]) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), file.endsWith(".json")
      ? JSON.stringify({ name: "agent-factory", version: "1.0.2+codex.dev" }) : "local source");
  }
  await activate(context(), services);
  assert.equal(bootstraps, 1);
  await writeFile(join(root, ".codex-plugin/plugin.json"), JSON.stringify({ name: "agent-factory", version: "2.0.0" }));
  await activate(context(), services);
  assert.equal(bootstraps, 1);
  assert.equal(errors.length, 2);
  assert.match(errors[1], /must match extension version/);
});

test("production activation ignores an inherited development plugin root", async (t) => {
  const previous = process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT;
  process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT = "/nonexistent/development/plugin";
  t.after(() => {
    if (previous === undefined) delete process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT;
    else process.env.AGENT_FACTORY_DEV_PLUGIN_ROOT = previous;
  });
  const { activate } = await importTypeScript("src/extension.ts", true);
  let installedChecks = 0;
  let bootstraps = 0;
  await activate({ extensionMode: 1, extension: { packageJSON: { version: "1.0.2" } } }, {
    ensurePlugin: async () => { installedChecks++; },
    bootstrap: () => { bootstraps++; },
    withProgress: async (_, task) => task(),
    showErrorMessage: async (message) => { assert.fail(message); }
  });
  assert.equal(installedChecks, 1);
  assert.equal(bootstraps, 1);
});

test("development root and child environment require explicit development selection", async () => {
  const { developmentPluginRoot, pluginRuntimeEnvironment } = await importTypeScript("src/infrastructure/agent-factory/development-plugin.ts");
  const inherited = { PATH: "/usr/bin", AGENT_FACTORY_DEV_PLUGIN_ROOT: "/local/plugin" };
  assert.equal(developmentPluginRoot(false, inherited), undefined);
  assert.equal(developmentPluginRoot(true, inherited), "/local/plugin");
  assert.deepEqual(pluginRuntimeEnvironment(undefined, inherited), { PATH: "/usr/bin" });
  assert.deepEqual(pluginRuntimeEnvironment("/f5/plugin", inherited), { PATH: "/usr/bin", AGENT_FACTORY_DEV_PLUGIN_ROOT: "/f5/plugin" });
  assert.equal(inherited.AGENT_FACTORY_DEV_PLUGIN_ROOT, "/local/plugin");
});

test("release metadata and installation guidance stay coupled", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const packageLock = JSON.parse(await readFile(new URL("../../package-lock.json", import.meta.url), "utf8"));
  const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
  const version = packageJson.version;

  assert.equal(packageLock.version, version);
  assert.equal(packageLock.packages[""].version, version);
  assert.match(readme, /installs the matching Agent Factory companion plugin when needed/);
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

test("matching older installed versions work even when a newer release is available", async () => {
  const process = queuedRunner([json(currentList(
    [record({ version: "1.0.8+codex.old", installed: true, enabled: true })],
    [record({ version: "1.0.11+codex.new" })]
  ))]);
  await dependency.ensureAgentFactoryPlugin("1.0.8", process.runner);
  assert.deepEqual(process.calls.map(call => call.args), [["plugin", "list", "--json"]]);
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
    const process = queuedRunner([{ stdout: "{" }, { stdout: "{" }]);
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

test("the Antigravity plugin is ensured after startup and its failure only warns", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const events = [];
  let release;
  const antigravity = new Promise(resolve => { release = resolve; });
  const services = {
    detectProviders: async () => ({ codex: true, claude: false, antigravity: true }),
    ensurePlugin: async () => { events.push("ensure"); },
    ensureAntigravityPlugin: async (version) => { events.push(`antigravity:${version}`); await antigravity; throw new Error("offline"); },
    showWarningMessage: async (message) => { events.push(`warning:${message}`); },
    bootstrap: () => { events.push("bootstrap"); },
    withProgress: async (_options, task) => task({}, {}),
    showErrorMessage: async (message) => { events.push(`error:${message}`); }
  };
  await activate({ extension: { packageJSON: { version: "1.0.19" } } }, services);
  // Startup does not wait for the optional GitHub install.
  assert.deepEqual(events, ["ensure", "antigravity:1.0.19", "bootstrap"]);
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(events.length, 4);
  assert.match(events[3], /^warning:.*offline/);
  assert.ok(!events.some(event => event.startsWith("error:")));
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

test("dismissed startup failure leaves the open command registered with recovery guidance and Retry", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.2" } } };
  const commands = new Map();
  let attempts = 0;
  let notifications = 0;
  let bootstraps = 0;
  const services = {
    ensurePlugin: async () => { if (++attempts === 1) throw new Error("Codex CLI missing from host PATH"); },
    bootstrap: () => { bootstraps++; },
    withProgress: async (_, task) => task(),
    showErrorMessage: async (message, action) => {
      notifications++;
      if (notifications === 1) return undefined;
      assert.match(message, /not ready/);
      assert.match(message, /Codex CLI missing/);
      assert.equal(action, "Retry");
      return "Retry";
    },
    registerCommand: (name, handler) => {
      commands.set(name, handler);
      return { dispose() { commands.delete(name); } };
    }
  };
  await activate(context, services);
  assert.equal(bootstraps, 0);
  assert.ok(commands.has("agentFactory.mainChat.open"));
  await commands.get("agentFactory.mainChat.open")();
  assert.equal(attempts, 2);
  assert.equal(bootstraps, 1);
  assert.ok(!commands.has("agentFactory.mainChat.open"));
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

test("WSL handoff is deduplicated and never starts the Windows plugin or chat runtime", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.13" } }, subscriptions: [] };
  let opens = 0;
  let handler, notice;
  const services = {
    detectProviders: async () => ({ codex: false, claude: false, antigravity: false }),
    redirectToWsl: async () => { opens++; return true; },
    ensurePlugin: async () => assert.fail("must not install into Windows"),
    bootstrap: () => assert.fail("must not bootstrap Windows runtime"),
    registerCommand: (name, callback) => { assert.equal(name, "agentFactory.mainChat.open"); handler = callback; return { dispose() {} }; },
    showInformationMessage: async message => { notice = message; },
    withProgress: async (_, task) => task(),
    showErrorMessage: async () => assert.fail("successful handoff should not show an error")
  };
  await Promise.all([activate(context, services), activate(context, services)]);
  await activate(context, services);
  assert.equal(opens, 1);
  await handler();
  assert.match(notice, /new WSL window/);
  assert.equal(context.subscriptions.length, 1);
});

test("Claude-only hosts activate with an installed plugin and never redirect or install through Codex", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.14" } }, subscriptions: [] };
  const calls = [];
  const services = {
    detectProviders: async () => { calls.push("detect"); return { codex: false, claude: true, antigravity: false }; },
    redirectToWsl: async () => assert.fail("a local Claude CLI makes the WSL redirect unnecessary"),
    ensurePlugin: async () => assert.fail("Codex marketplace is unavailable without Codex"),
    ensureClaudePlugin: async version => { calls.push(`claude-plugin:${version}`); },
    requireInstalledPlugin: async version => { calls.push(`installed:${version}`); },
    initializeDefaults: async (actualContext, providers) => {
      assert.equal(actualContext, context);
      assert.deepEqual(providers, { codex: false, claude: true });
      calls.push("defaults");
    },
    bootstrap: () => { calls.push("bootstrap"); },
    withProgress: async (_, task) => task(),
    showErrorMessage: async () => assert.fail("Claude-only activation should succeed")
  };
  await activate(context, services);
  assert.deepEqual(calls, ["detect", "claude-plugin:1.0.14", "installed:1.0.14", "defaults", "bootstrap"]);
});

test("with both CLIs, both plugins are managed and a Claude plugin failure only warns", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.17" } }, subscriptions: [] };
  const calls = [];
  const services = {
    detectProviders: async () => ({ codex: true, claude: true, antigravity: false }),
    ensurePlugin: async version => { calls.push(`codex-plugin:${version}`); },
    ensureClaudePlugin: async () => { calls.push("claude-plugin"); throw new Error("marketplace offline"); },
    requireInstalledPlugin: async () => assert.fail("Codex installs the runtime"),
    showWarningMessage: async message => { calls.push(`warning:${/marketplace offline/.test(message)}`); },
    bootstrap: () => { calls.push("bootstrap"); },
    withProgress: async (_, task) => task(),
    showErrorMessage: async () => assert.fail("a Claude plugin failure must not block Codex")
  };
  await activate(context, services);
  assert.deepEqual(calls, ["codex-plugin:1.0.17", "claude-plugin", "warning:true", "bootstrap"]);
});

test("Claude-only activation fails when the Claude plugin cannot be installed", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.17" } }, subscriptions: [] };
  let shown;
  const services = {
    detectProviders: async () => ({ codex: false, claude: true, antigravity: false }),
    ensurePlugin: async () => assert.fail("no Codex"),
    ensureClaudePlugin: async () => { throw new Error("claude install failed"); },
    requireInstalledPlugin: async () => assert.fail("must not continue"),
    bootstrap: () => assert.fail("must not bootstrap"),
    withProgress: async (_, task) => task(),
    showErrorMessage: async message => { shown = message; return undefined; }
  };
  await activate(context, services);
  assert.match(shown, /claude install failed/);
});

test("with no provider CLI the chat still starts without plugin checks and warns once", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.14" } }, subscriptions: [] };
  const calls = [];
  const services = {
    detectProviders: async () => ({ codex: false, claude: false, antigravity: false }),
    redirectToWsl: async () => { calls.push("redirect"); return false; },
    ensurePlugin: async () => assert.fail("must not install without Codex"),
    ensureClaudePlugin: async () => assert.fail("must not install without Claude"),
    ensureAntigravityPlugin: async () => assert.fail("must not install without agy"),
    requireInstalledPlugin: async () => assert.fail("no provider can use the runtime yet"),
    initializeDefaults: async (_, providers) => { calls.push(`defaults:${providers.codex}:${providers.claude}`); },
    showWarningMessage: async () => { calls.push("warning"); },
    bootstrap: () => { calls.push("bootstrap"); },
    withProgress: async (_, task) => task(),
    showErrorMessage: async message => assert.fail(message)
  };
  await activate(context, services);
  assert.deepEqual(calls, ["redirect", "warning", "defaults:false:false", "bootstrap"]);
});

test("an Antigravity-only host waits for its plugin before requiring the installed runtime", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const context = { extension: { packageJSON: { version: "1.0.21" } }, subscriptions: [] };
  const calls = [];
  const services = {
    detectProviders: async () => ({ codex: false, claude: false, antigravity: true }),
    redirectToWsl: async () => assert.fail("agy is a local provider"),
    ensurePlugin: async () => assert.fail("no Codex"),
    ensureAntigravityPlugin: async version => { calls.push(`agy-plugin:${version}`); },
    requireInstalledPlugin: async version => { calls.push(`installed:${version}`); },
    bootstrap: () => { calls.push("bootstrap"); },
    withProgress: async (_, task) => task(),
    showErrorMessage: async message => assert.fail(message)
  };
  await activate(context, services);
  assert.deepEqual(calls, ["agy-plugin:1.0.21", "installed:1.0.21", "bootstrap"]);
});

test("sidebar placeholder claims the view during startup and releases it before bootstrap", async () => {
  const { activate } = await importTypeScript("src/extension.ts", true);
  const events = [];
  const view = { message: undefined, dispose() { events.push("dispose"); } };
  let fail = true;
  const services = {
    createStartupView: () => { events.push("create"); return view; },
    ensurePlugin: async () => { events.push(`check:${view.message}`); if (fail) throw new Error("broken"); },
    bootstrap: () => { events.push("bootstrap"); },
    withProgress: async (_, task) => task(),
    showErrorMessage: async () => undefined
  };
  const context = { extensionMode: 1, subscriptions: [], extension: { packageJSON: { version: "1.0.2" } } };
  await activate(context, services);
  assert.deepEqual(events, ["create", "check:Starting Agent Factory…"]);
  assert.match(view.message, /could not start\. broken/);
  fail = false;
  await activate(context, services);
  assert.deepEqual(events.slice(2), [`check:${view.message}`, "dispose", "bootstrap"]);
  assert.deepEqual(context.subscriptions, [view]);
});

test("CLI JSON parsing tolerates update notices and retries a disturbed plugin list once", async () => {
  const listed = JSON.stringify({ installed: [{ pluginId: "agent-factory@agent-factory", name: "agent-factory",
    marketplaceName: "agent-factory", version: "1.0.2+codex.1", installed: true, enabled: true }] });
  assert.deepEqual(dependency.parseCliJson(`✨ Update available! 0.1 -> 0.2 [see notes]\n${listed}\nRun codex update {now}\n`), JSON.parse(listed));
  assert.throws(() => dependency.parseCliJson("Update available [x]"));
  const outputs = ["", `WARNING: plugin cache is being updated\n${listed}`];
  let calls = 0;
  await dependency.ensureAgentFactoryPlugin("1.0.2", async () => ({ stdout: outputs[calls++] }));
  assert.equal(calls, 2);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", async () => ({ stdout: "not json" })),
    /not valid JSON\. Output: \(not json\)/);
});

test("Codex command failures surface stderr and point invalid configuration at config.toml", async () => {
  const failure = (stderr) => async () => { throw Object.assign(new Error("Command failed"), { code: 1, stderr }); };
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2",
    failure("Error: failed to load configuration\n\nCaused by:\n    invalid type: string \"gpt-6-sol\", expected a boolean\n    in `features`\n")),
    /configuration is invalid\. Fix ~\/\.codex\/config\.toml.*expected a boolean in `features`/);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", failure("\u001b[31mnetwork unreachable\u001b[0m\n")),
    /failed\. Codex reported: network unreachable$/);
  await assert.rejects(dependency.ensureAgentFactoryPlugin("1.0.2", failure("")),
    /Check the Codex CLI installation/);
});
