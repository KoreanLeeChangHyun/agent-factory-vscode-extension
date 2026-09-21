#!/usr/bin/env node
/** Bounded, opt-in resource baseline over current panel/runtime and UI algorithms. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const extensionRoot = new URL("../..", import.meta.url).pathname;
const outputIndex = process.argv.indexOf("--output");
if (outputIndex < 0 || !process.argv[outputIndex + 1]) throw new Error("usage: node tests/benchmarks/resource-baseline.mjs --output <new-json-path>");
const outputPath = process.argv[outputIndex + 1];
const temporary = await mkdtemp(join(tmpdir(), "af-extension-resource-baseline-"));
const runtimeHome = join(temporary, "runtime");
const projectRoot = join(temporary, "project");
const externalDiagnosticPath = join(temporary, "runtime-diagnostics.jsonl");
const listPath = join(temporary, "agents.json");
const fakeExec = join(temporary, "fake-exec.py");
const fakeLoop = join(temporary, "loop.py");
const diagnosticShim = join(temporary, "diagnostic-fs.mjs");
await mkdir(projectRoot, { recursive: true });
const projectId = "project-" + createHash("sha256").update(projectRoot).digest("hex").slice(0, 32);
const agentsRoot = join(runtimeHome, "projects", projectId, "agents");
process.env.AGENT_FACTORY_HOME = runtimeHome;
globalThis.__afResourceDiagnostics = [];

await writeFile(diagnosticShim, `
import * as native from "node:fs/promises";
const emit = event => globalThis.__afResourceDiagnostics?.push(event);
export const lstat = native.lstat, mkdtemp = native.mkdtemp, realpath = native.realpath, rm = native.rm, writeFile = native.writeFile;
export async function readdir(path, options) {
  try { const entries = await native.readdir(path, options); emit({ kind: "scan", path: String(path), entries: entries.length }); return entries; }
  catch (error) { emit({ kind: "scan", path: String(path), entries: 0, error: error?.code }); throw error; }
}
export async function readFile(path, options) {
  const value = await native.readFile(path, options);
  emit({ kind: "read", path: String(path), bytes: Buffer.isBuffer(value) ? value.length : Buffer.byteLength(value) });
  return value;
}
export async function open(path, flags, mode) {
  const handle = await native.open(path, flags, mode);
  return new Proxy(handle, { get(target, property) {
    if (property === "read") return async (...args) => { const result = await target.read(...args); if (result.bytesRead > 0) emit({ kind: "read", path: String(path), bytes: result.bytesRead }); return result; };
    const value = target[property]; return typeof value === "function" ? value.bind(target) : value;
  }});
}
`);

const sourcePath = join(extensionRoot, "src/infrastructure/agent-factory/agent-client.ts");
const source = await readFile(sourcePath);
const instrumentCurrentAdapter = { name: "instrument-current-runtime-adapter", setup(buildApi) {
  buildApi.onLoad({ filter: /agent-client\.ts$/ }, async args => ({ loader: "ts", contents:
    (await readFile(args.path, "utf8")).replace('from "node:fs/promises";', `from ${JSON.stringify(diagnosticShim)};`) }));
} };
const compiled = await build({ entryPoints: [sourcePath], bundle: true, format: "esm", platform: "node", target: "node18", write: false, plugins: [instrumentCurrentAdapter] });
const { AgentFactoryClient } = await import("data:text/javascript;base64," + Buffer.from(compiled.outputFiles[0].text).toString("base64"));

const managerPath = join(extensionRoot, "src/infrastructure/vscode/chat-panel-manager.ts");
const managerBuild = await build({ entryPoints: [managerPath], bundle: true, format: "cjs", platform: "node", target: "node18", write: false, external: ["vscode"] });
const require = createRequire(import.meta.url);
const vscode = {
  ViewColumn: { Active: -1 }, ConfigurationTarget: { Global: 1 },
  Uri: { parse(value) { return { value }; }, file(fsPath) { return { fsPath }; } },
  env: { clipboard: { async writeText() {} }, async openExternal() { return true; } }, commands: { async executeCommand() {} },
  window: { async showSaveDialog() {}, async showTextDocument() {} },
  workspace: { fs: { async copy() {} }, async openTextDocument() { return {}; }, getConfiguration() { return { get(_key, fallback) { return fallback; }, async update() {} }; } }
};
const managerModule = { exports: {} };
runInNewContext(managerBuild.outputFiles[0].text, { module: managerModule, exports: managerModule.exports, Buffer, URL, console, process, setTimeout, clearTimeout, global: { Date }, require: name => name === "vscode" ? vscode : require(name) });
const { ChatPanelManager } = managerModule.exports;

const python = `#!/usr/bin/env python3
import json, pathlib, sys
diagnostics = pathlib.Path(${JSON.stringify(externalDiagnosticPath)})
def emit(value):
    with diagnostics.open("a", encoding="utf-8") as stream: stream.write(json.dumps(value) + "\\n")
def option(name): return sys.argv[sys.argv.index(name) + 1]
command = sys.argv[1]
emit({"kind": "process", "command": command})
if command == "init":
    print(json.dumps({"schemaVersion": 1, "kind": "runtime-location", "home": ${JSON.stringify(runtimeHome)}, "projectRoot": ${JSON.stringify(projectRoot)}, "projectId": ${JSON.stringify(projectId)}, "runtimeRoot": ${JSON.stringify(join(runtimeHome, "projects", projectId))}, "agentsRoot": ${JSON.stringify(agentsRoot)}, "registered": True}))
elif command == "list": print(pathlib.Path(${JSON.stringify(listPath)}).read_text(encoding="utf-8"))
elif command == "status":
    path = pathlib.Path(${JSON.stringify(agentsRoot)}) / option("--agent") / "runs" / option("--run-id") / "state.json"
    content = path.read_bytes(); emit({"kind": "read", "path": str(path), "bytes": len(content)})
    print(json.dumps({"run": json.loads(content.decode("utf-8"))}))
else:
    print(json.dumps({"kind": "error", "error": {"message": "unsupported fixture command"}})); raise SystemExit(2)
`;
const loopPython = `#!/usr/bin/env python3
import json, pathlib, sys
diagnostics = pathlib.Path(${JSON.stringify(externalDiagnosticPath)})
def emit(value):
    with diagnostics.open("a", encoding="utf-8") as stream: stream.write(json.dumps(value) + "\\n")
def option(name): return sys.argv[sys.argv.index(name) + 1]
verb, agent, loop = sys.argv[1], option("--work-agent"), option("--loop-id")
path = pathlib.Path(${JSON.stringify(agentsRoot)}) / agent / "loops" / loop / "state.json"
content = path.read_bytes(); emit({"kind": "process", "command": "loop:" + verb}); emit({"kind": "read", "path": str(path), "bytes": len(content)})
print(json.dumps({"kind": "loop-status", "loopId": loop, "status": "completed", "workAgentId": agent}))
`;
await writeFile(fakeExec, python, { mode: 0o700 });
await writeFile(fakeLoop, loopPython, { mode: 0o700 });
await writeFile(externalDiagnosticPath, "");

const allAgents = [];
async function writeFixture(path, content) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
async function createHistoryFixture(runCount, withWorkflow = false) {
  const agentId = `main-history-${runCount}`, root = join(agentsRoot, agentId);
  await writeFixture(join(root, "session.json"), JSON.stringify({ agentId, conversationId: "conversation-baseline" }));
  for (let index = 0; index < runCount; index += 1) {
    const runId = `run-${String(index).padStart(4, "0")}`, childId = `work-${runCount}-${String(index).padStart(4, "0")}`, childRun = `child-${String(index).padStart(4, "0")}`;
    const runRoot = join(root, "runs", runId), statePath = join(runRoot, "state.json");
    await writeFixture(statePath, JSON.stringify({ agentId, runId, conversationId: "conversation-baseline", status: "completed", taskMode: "work", executionPolicy: { schemaVersion: 1 } }));
    await writeFixture(join(runRoot, "request.md"), `bounded request ${index} ` + "q".repeat(96));
    await writeFixture(join(runRoot, "result.md"), `bounded result ${index} ` + "r".repeat(192));
    const command = `python3 /fixture/skills/agent/scripts/exec.py submit --project-root ${projectRoot} --agent ${childId}`;
    await writeFixture(join(runRoot, "events.jsonl"), JSON.stringify({ item: { type: "command_execution", command, aggregated_output: JSON.stringify({ kind: "ack", agentId: childId, runId: childRun }) } }) + "\n");
    await writeFixture(join(agentsRoot, childId, "runs", childRun, "state.json"), JSON.stringify({ agentId: childId, runId: childRun, status: "completed", parentAgentId: agentId, parentRunId: runId }));
    await writeFixture(join(agentsRoot, childId, "session.json"), JSON.stringify({ agentId: childId, role: "work" }));
    if (withWorkflow && index === 0) await writeFixture(join(agentsRoot, childId, "loops", "loop-baseline", "state.json"), JSON.stringify({ status: "active", workflow: { id: "baseline" }, parentStatePath: statePath }));
    allAgents.push({ agentId: childId, role: "work", updatedAt: `2026-09-19T00:${String(index % 60).padStart(2, "0")}:00Z` });
  }
  return agentId;
}
const historyAgents = [];
for (const runCount of [10, 100, 500]) historyAgents.push(await createHistoryFixture(runCount, runCount === 100));
await writeFile(listPath, JSON.stringify({ agents: allAgents }));

async function createActiveFixture(index, bytes) {
  const agentId = `main-active-${index}`, runId = "run-active", root = join(agentsRoot, agentId, "runs", runId);
  const event = JSON.stringify({ type: "item.completed", item: { id: `item-${index}`, type: "command_execution", command: "true", status: "completed" } });
  await writeFixture(join(root, "events.jsonl"), event + " ".repeat(Math.max(0, bytes - Buffer.byteLength(event) - 1)) + "\n");
  await writeFixture(join(root, "state.json"), JSON.stringify({ agentId, runId, status: "running" }));
  return { agentId, runId };
}
const activeFixtures = [];
for (let index = 0; index < 4; index += 1) activeFixtures.push(await createActiveFixture(index, 64 * 1024));

function usageSnapshot() { const cpu = process.cpuUsage(), memory = process.memoryUsage(); return { cpu, heapUsed: memory.heapUsed, rss: memory.rss }; }
function usageDelta(before, began) { const cpu = process.cpuUsage(before.cpu), memory = process.memoryUsage(); return { wallMs: performance.now() - began, cpuUserMs: cpu.user / 1000, cpuSystemMs: cpu.system / 1000, heapDeltaBytes: memory.heapUsed - before.heapUsed, rssDeltaBytes: memory.rss - before.rss }; }
async function externalDiagnostics() { const content = await readFile(externalDiagnosticPath, "utf8"); return content.trim() ? content.trim().split("\n").map(line => JSON.parse(line)) : []; }
async function resetDiagnostics() { globalThis.__afResourceDiagnostics.length = 0; await writeFile(externalDiagnosticPath, ""); }
function summarizeDiagnostics(events) {
  const reads = events.filter(event => event.kind === "read"), scans = events.filter(event => event.kind === "scan"), processes = events.filter(event => event.kind === "process");
  return { directoryScans: scans.length, directoryEntriesObserved: scans.reduce((total, event) => total + event.entries, 0), fileReadCalls: reads.length,
    readBytes: reads.reduce((total, event) => total + event.bytes, 0), processStarts: processes.length,
    processStartCommands: Object.fromEntries([...new Set(processes.map(event => event.command))].map(command => [command, processes.filter(event => event.command === command).length])) };
}
async function measured(action) {
  const before = usageSnapshot(), localStart = globalThis.__afResourceDiagnostics.length, externalStart = (await externalDiagnostics()).length, began = performance.now();
  const value = await action();
  const events = globalThis.__afResourceDiagnostics.slice(localStart).concat((await externalDiagnostics()).slice(externalStart));
  return { ...usageDelta(before, began), ...summarizeDiagnostics(events), ...value };
}
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

const client = new AgentFactoryClient(fakeExec, projectRoot);
const managedPanel = agentId => ({ state: { agentId, role: "main" }, panel: { webview: { async postMessage() { return true; } } } });

const evidence = {
  schemaVersion: 2, label: "Agent Factory extension bounded resource baseline",
  source: { adapter: { path: "src/infrastructure/agent-factory/agent-client.ts", sha256: createHash("sha256").update(source).digest("hex") }, panelManager: { path: "src/infrastructure/vscode/chat-panel-manager.ts", sha256: createHash("sha256").update(await readFile(managerPath)).digest("hex") } },
  environment: { node: process.version, platform: process.platform, architecture: process.arch },
  isolation: { disposableFixture: true, realRuntimeHistoryUsed: false, networkUsed: false, boundedRuns: 610, maxPanels: 4 },
  closedIdleLifecycle: [], openIdleLifecycle: [], childListComponent: [], history: [], active: [], renderingProxy: [],
  limitations: [
    "File scans, read calls/bytes, and process starts are observed from the instrumented disposable adapter plus fixture runtime processes, not derived from fixture-size formulas.",
    "Fixed-cycle idle measurements call the current sendAgentList orchestration without waiting the production two-second timer between cycles.",
    "Rendering proxy measures the current full-list scan and render-key computation shape in Node, not VS Code Webview layout, paint, or GPU usage.", "GPU was not measured."
  ]
};

for (const agentId of historyAgents) {
  const runCount = Number(agentId.split("-").at(-1)), row = await measured(async () => ({ messages: (await client.history(agentId)).messages.length }));
  assert.equal(row.messages, runCount * 2); assert.equal(row.directoryScans, 1); assert.equal(row.fileReadCalls, runCount * 3 + 2); assert.ok(row.readBytes > 0);
  evidence.history.push({ runCount, ...row });
}
await client.history(historyAgents[0]);
const componentAgent = historyAgents.at(-1);
for (const panels of [1, 4]) {
  const scenarioClient = new AgentFactoryClient(fakeExec, projectRoot);
  await scenarioClient.history(historyAgents[0]);
  await resetDiagnostics();
  const row = await measured(async () => ({ visibleChildren: (await Promise.all(
    Array.from({ length: panels }, () => scenarioClient.listChildSessions(componentAgent))
  )).reduce((total, children) => total + children.length, 0) }));
  assert.equal(row.processStarts, 0); assert.ok(row.directoryScans <= 501); assert.ok(row.fileReadCalls <= 2000); assert.ok(row.readBytes > 0);
  evidence.childListComponent.push({ panels, callsPerPanel: 1, ...row });
}

const idleAgent = historyAgents[1], cycles = 3, cadenceMs = 10;
for (const panels of [1, 4]) {
  const idleClient = new AgentFactoryClient(fakeExec, projectRoot);
  await idleClient.history(historyAgents[0]);
  const idleManager = new ChatPanelManager({}, {}, () => [], async () => ({ available: true, client: idleClient }));
  idleManager.scheduleAgentList = () => {};
  idleManager.reportWorkflowResults = async () => {};
  idleManager.continueBackgroundWork = async () => {};
  await resetDiagnostics();
  const closed = await measured(async () => { for (let cycle = 0; cycle < cycles; cycle += 1) if (cycle + 1 < cycles) await delay(cadenceMs); return {}; });
  assert.deepEqual({ scans: closed.directoryScans, reads: closed.fileReadCalls, bytes: closed.readBytes, starts: closed.processStarts }, { scans: 0, reads: 0, bytes: 0, starts: 0 });
  evidence.closedIdleLifecycle.push({ nominalPanels: panels, cycles, cadenceMs, ...closed });
  const panelsToRefresh = Array.from({ length: panels }, () => managedPanel(idleAgent));
  const open = await measured(async () => { for (let cycle = 0; cycle < cycles; cycle += 1) { await Promise.all(panelsToRefresh.map(panel => idleManager.sendAgentList(panel))); if (cycle + 1 < cycles) await delay(cadenceMs); } return {}; });
  assert.ok(open.processStarts >= 1 && open.processStarts <= cycles); assert.ok(open.directoryScans <= cycles * 201);
  assert.ok(open.fileReadCalls <= 403 + (cycles - 1) * 203); assert.ok(open.readBytes > 0);
  evidence.openIdleLifecycle.push({ panels, cycles, cadenceMs, normalized: {
    cpuMsPerPanelCycle: (open.cpuUserMs + open.cpuSystemMs) / (panels * cycles), wallMsPerPanelCycle: open.wallMs / (panels * cycles),
    scansPerPanelCycle: open.directoryScans / (panels * cycles), readBytesPerPanelCycle: open.readBytes / (panels * cycles), processStartsPerPanelCycle: open.processStarts / (panels * cycles)
  }, ...open });
}

for (const panels of [1, 4]) {
  const activeClient = new AgentFactoryClient(fakeExec, projectRoot);
  await activeClient.history(historyAgents[0]);
  await resetDiagnostics();
  const polls = 12, row = await measured(async () => { for (let poll = 0; poll < polls; poll += 1) for (let panel = 0; panel < panels; panel += 1) {
    const fixture = activeFixtures[panel]; await activeClient.updates(fixture.agentId, fixture.runId, 0); if (poll % 3 === 0) await activeClient.status(fixture.agentId, fixture.runId);
  } return {}; });
  const eventReads = panels; // Each run retains its unchanged event snapshot.
  assert.ok(row.processStarts <= panels * 4); assert.ok(row.fileReadCalls <= eventReads + panels + panels * 4); assert.ok(row.readBytes > 0);
  evidence.active.push({ panels, pollsPerPanel: polls, statusPollStride: 3, ...row });
}

// Optional wall-clock sampling; uses disposable histories, never live sessions.
const soakIndex = process.argv.indexOf("--soak-seconds");
if (soakIndex >= 0) {
  const seconds = Number(process.argv[soakIndex + 1]);
  assert.ok(Number.isInteger(seconds) && seconds >= 1 && seconds <= 600);
  const soakClient = new AgentFactoryClient(fakeExec, projectRoot);
  await soakClient.history(historyAgents[0]);
  const samples = [];
  for (let i = 0; i <= seconds; i++) {
    await resetDiagnostics();
    const cost = await measured(async () => {
      await Promise.all(activeFixtures.map(f => soakClient.updates(f.agentId, f.runId, 0)));
      return {};
    });
    global.gc?.();
    samples.push({ second: i, heapUsed: process.memoryUsage().heapUsed, rss: process.memoryUsage().rss, ...cost });
    if (i < seconds) await delay(1000);
  }
  evidence.soak = { seconds, gcAvailable: Boolean(global.gc), samples,
    limitation: "Isolated adapter under periodic reads; not a production host or a proof of absence of long-term leaks." };
}
evidence.refreshStages = [];
const stageClient = new AgentFactoryClient(fakeExec, projectRoot);
await stageClient.history(historyAgents[0]);
for (let cycle = 0; cycle < 3; cycle++) {
  await resetDiagnostics();
  let children;
  const childLookup = await measured(async () => { children = await stageClient.listChildSessions(idleAgent); return {}; });
  const workflowLookup = await measured(async () => { await stageClient.advanceWorkflows(idleAgent, children, false); return {}; });
  evidence.refreshStages.push({ cycle, childLookup, workflowLookup });
  await delay(300);
}
evidence.pagedHistory = [];
for (const id of historyAgents) {
  await resetDiagnostics();
  evidence.pagedHistory.push(await measured(async () => {
    const page = await stageClient.history(id, { limit: 50 });
    return { runCount: Number(id.split("-").at(-1)), messages: page.messages.length };
  }));
}

function renderingProxy(size) {
  const timeline = Array.from({ length: size }, (_, index) => ({ type: "activity", id: `event-${index}`, category: "command", phase: "completed", text: `command ${index}`, output: "ok" }));
  const before = usageSnapshot(), began = performance.now(); let bytes = 0;
  for (let pass = 0; pass < 5; pass += 1) for (const event of timeline) bytes += JSON.stringify([event, 0, "en", null, null, null]).length;
  for (let update = 0; update < 100; update += 1) timeline.find(event => event.type === "activity" && event.id === `event-${size - 1}`);
  return { timelineItems: size, passes: 5, upserts: 100, domElementsScannedProxy: size * 10, renderKeyBytes: bytes, ...usageDelta(before, began) };
}
for (const size of [200, 1000, 5000]) evidence.renderingProxy.push(renderingProxy(size));
evidence.comparisonMethod = { command: "node tests/benchmarks/resource-baseline.mjs --output <new-json-path>",
  compare: "Use the same machine and fixture sizes; counters are observed from actual adapter/panel operations. Compare exact counters and median CPU/wall/RSS/heap over at least three fresh invocations.",
  thresholds: { closedIdle: "must remain exactly zero scans, reads, read bytes, and process starts", correctness: "history messages must equal 2x completed runs; lifecycle refresh must execute list, workflow advancement, and conditional reread",
    resourceRegression: "observed reads/scans/process starts must not increase; median CPU/wall may not exceed max(1.25x baseline, baseline + 5ms)", scaling: "the largest/smallest workload wall-time ratio must not worsen by more than 25% versus this recorded curve; investigate super-linear growth" } };

await writeFile(outputPath, JSON.stringify(evidence, null, 2) + "\n", { flag: "wx" });
await rm(temporary, { recursive: true, force: true });
console.log(JSON.stringify({ ok: true, output: outputPath, history: evidence.history.length, idleLifecycle: evidence.openIdleLifecycle.length, component: evidence.childListComponent.length, active: evidence.active.length, rendering: evidence.renderingProxy.length }));
