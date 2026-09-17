import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import { build } from "esbuild";

const script = await readFile(new URL("../../static/js/chat.js", import.meta.url), "utf8");
const section = (from, to) => script.slice(script.indexOf(from), script.indexOf(to, script.indexOf(from)));
const clean = value => JSON.parse(JSON.stringify(value));
function harness() {
  const sent = [], persisted = [], elements = [];
  function element() {
    const classes = new Set();
    const node = {
      children: [], dataset: {}, handlers: {}, hidden: false, attrs: {},
      classList: { add: (...names) => names.forEach(name => classes.add(name)), remove: (...names) => names.forEach(name => classes.delete(name)), contains: name => classes.has(name) },
      setAttribute(name, value) { this.attrs[name] = value; },
      append(...nodes) { this.children.push(...nodes); nodes.forEach(child => { child.parent = this; }); },
      replaceChildren() { this.children = []; },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      contains(target) { return target === this || this.children.some(child => child.contains(target)); },
      querySelectorAll(selector) {
        const all = this.children.flatMap(child => [child, ...child.querySelectorAll(selector)]);
        if (selector === '[data-preview-id]') return all.filter(child => child.dataset.previewId);
        return all;
      },
      querySelector() { return undefined; },
      getBoundingClientRect() { return { top: 0, left: 0, width: 100, height: 40 }; },
      focus() {}
    };
    elements.push(node);
    return node;
  }
  const nodes = new Map();
  const context = {
    document: { createElement: element, createElementNS: (_namespace, _tag) => element(), getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); }, querySelectorAll: () => elements },
    state: { statusItems: ["project", "branch", "queue"], title: "Main", role: "main", runtimeAvailable: true, workUnitsKnown: true, workUnits: { workActive: 1, verificationActive: 2, totalCalled: 3 }, queueCount: 0 },
    nativeGoal: null, goalError: undefined, taskModeNames: { work: "Work" },
    currentCapabilities: () => ({ model: true, reasoning: true, fast: true }),
    renderStatusBar() {},
    persist() { persisted.push(clean(context.state.statusItems)); },
    vscode: { postMessage(message) { sent.push(clean(message)); } }
  };
  runInNewContext([
    section('  const defaultStatusItems =', '  const longPasteThreshold'),
    section('  function setStatusItems(', '  statusSettingsButton.addEventListener'),
    section('  function statusLabel(', '  function updateSendButton('),
    section('  function normalizeStatusItems(', '  function saveComposerSettings('),
    section('  function safeCountOrUndefined(', '  function normalizeStatusItems('),
    section('  function contextStatusLabel(', '  function renderContextStatus('),
    section('  function formatElapsed(', '  function renderAttachments(')
  ].join('\n'), context);
  const run = code => runInNewContext(code, context);
  return { context, sent, persisted, run, element, nodes };
}

test("selection preserves empty arrays, order and legacy IDs without injecting hidden items", () => {
  const { run, sent, persisted } = harness();
  assert.deepEqual(clean(run('normalizeStatusItems(["runtime", "agent", "runtime", "invalid"])')), ["runtime", "agent"]);
  assert.deepEqual(clean(run('normalizeStatusItems([])')), []);
  assert.deepEqual(clean(run('normalizeStatusItems(undefined)')), ["status", "agents", "project", "branch", "context", "queue"]);
  run('setStatusItems(["weekly", "model"]); setStatusItems([])');
  assert.deepEqual(sent.at(-1), { type: "status.reorder", items: [] });
  assert.deepEqual(persisted, [["weekly", "model"], []]);
});

test("catalog checkboxes toggle fields and keyboard buttons persist ordered choices", () => {
  const { run, nodes, context, sent } = harness();
  run('renderStatusCatalog()');
  const row = id => nodes.get('status-catalog').children.find(node => node.dataset.itemId === id);
  const checkbox = row('branch').children[0].children[0].children[0];
  checkbox.checked = false;
  checkbox.handlers.change();
  assert.deepEqual(clean(context.state.statusItems), ['project', 'queue']);
  const weekly = row('weekly').children[0].children[0].children[0];
  weekly.checked = true;
  weekly.handlers.change();
  row('weekly').children[1].children[0].handlers.click();
  assert.deepEqual(sent.at(-1).items, ['project', 'weekly', 'queue']);
  assert.equal(row('project').children[1].children[0].disabled, true);
});

test("native drag inserts before/after target and ignores external drags", () => {
  const { context, run, element, sent } = harness();
  context.source = element(); context.target = element();
  run('bindStatusDrag(source, "project", false); bindStatusDrag(target, "queue", false)');
  const data = new Map();
  const transfer = { setData: (key, value) => data.set(key, value), getData: key => data.get(key) };
  const event = { dataTransfer: transfer, clientX: 90, preventDefault() {}, stopPropagation() {} };
  context.target.handlers.drop(event);
  assert.equal(sent.length, 0);
  context.source.handlers.dragstart(event);
  context.target.handlers.dragover(event);
  assert.equal(context.target.classList.contains('status-drop-after'), true);
  context.target.handlers.drop(event);
  assert.deepEqual(sent.at(-1).items, ['branch', 'queue', 'project']);
  run('reorderStatus("project", "branch", false)');
  assert.deepEqual(sent.at(-1).items, ['project', 'branch', 'queue']);
  run('moveStatus("project", -1)');
  assert.equal(sent.length, 2);
});

test("live labels distinguish absent values, zero usage, selected model and elapsed time", () => {
  const { run, context } = harness();
  assert.match(run('statusLabel("weekly")'), /—/);
  context.state.weeklyUsedPercent = 0;
  assert.match(run('statusLabel("weekly")'), /0%/);
  context.state.model = 'chosen-model';
  assert.equal(run('statusLabel("model")'), 'Model chosen-model');
  assert.equal(run('statusLabel("elapsed")'), 'Elapsed —');
  context.state.running = true; context.state.runStartedAt = Date.now() - 5000;
  assert.doesNotMatch(run('statusLabel("elapsed")'), /—/);
  context.state.contextWindowTokens = 0; context.state.contextUsedTokens = 0;
  assert.match(run('statusLabel("context")'), /Ctx left —/);
  context.nativeGoal = { tokensUsed: 0, timeUsedSeconds: 0, status: 'active' };
  assert.equal(run('statusLabel("goalTokens")'), 'Goal used 0 tokens');
  assert.match(run('statusLabel("goalBudget")'), /—/);
  context.state.workUnitsKnown = false;
  assert.match(run('statusLabel("agents")'), /—/);
  context.state.running = false;
  assert.equal(run('statusLabel("status")'), 'Idle');
  context.state.running = true;
  assert.equal(run('statusLabel("status")'), 'Running');
  context.state.pendingDecisionRunId = 'pending-run';
  assert.equal(run('statusLabel("status")'), 'Awaiting input');
  context.state.pendingDecisionRunId = undefined;
  context.state.running = false;
  context.state.runtimeAvailable = false;
  assert.equal(run('statusLabel("status")'), 'Offline');
  context.currentCapabilities = () => ({});
  assert.equal(run('statusLabel("model")'), 'Model Unknown');
  context.state.title = 'my-long-agent-name';
  context.state.projectName = 'my-long-project-name';
  assert.equal(run('statusLabel("agent")'), context.state.title);
  assert.equal(run('statusLabel("project")'), context.state.projectName);
});

test("Content and Weekly used/remaining items are independently selectable and calculated", () => {
  const { run, context, sent } = harness();
  run('setStatusItems(["contextUsed", "context", "weekly", "weeklyRemaining"])');
  assert.deepEqual(sent.at(-1).items, ['contextUsed', 'context', 'weekly', 'weeklyRemaining']);
  Object.assign(context.state, { contextUsedTokens: 54_264, contextWindowTokens: 258_400, weeklyUsedPercent: 12.5 });
  assert.equal(run('statusLabel("contextUsed")'), 'Ctx used 54,264 tokens');
  assert.equal(run('statusLabel("context")'), 'Ctx left 79%');
  assert.equal(run('statusLabel("weekly")'), 'Wk used 12.5%');
  assert.equal(run('statusLabel("weeklyRemaining")'), 'Wk left 87.5%');
  context.state.contextUsedTokens = undefined;
  assert.equal(run('statusLabel("contextUsed")'), 'Ctx used — tokens');
  assert.equal(run('statusLabel("context")'), 'Ctx left —');
  assert.equal(run('statusLabel("weeklyRemaining")'), 'Wk left 87.5%');
  context.state.weeklyUsedPercent = undefined;
  assert.equal(run('statusLabel("weeklyRemaining")'), 'Wk left —');
  context.state.contextUsedTokens = 0;
  assert.equal(run('statusLabel("contextUsed")'), 'Ctx used 0 tokens');
  assert.equal(run('statusLabel("context")'), 'Ctx left 100%');
  for (const used of [0, 100]) {
    context.state.weeklyUsedPercent = used;
    assert.equal(run('statusLabel("weekly")'), `Wk used ${used}%`);
    assert.equal(run('statusLabel("weeklyRemaining")'), `Wk left ${100 - used}%`);
  }
  context.state.contextUsedTokens = 300_000;
  assert.equal(run('statusLabel("context")'), 'Ctx left 0%');
  assert.equal(run('statusLabel("contextUsed")'), 'Ctx used 300,000 tokens');
  for (const window of [0, undefined]) {
    context.state.contextWindowTokens = window;
    assert.equal(run('statusLabel("context")'), 'Ctx left —');
    assert.equal(run('statusLabel("contextUsed")'), 'Ctx used 300,000 tokens');
    assert.equal(run('statusLabel("contextWindow")'), 'Ctx window — tokens');
  }
  context.state.branch = 'feature/status';
  assert.equal(run('statusLabel("branch")'), 'feature/status');
  context.state.branch = undefined;
  assert.equal(run('statusLabel("branch")'), '—');
});

test("Content percentage and token counts remain separate through selection and missing data", () => {
  const { run, context, sent } = harness();
  const items = ['weekly', 'contextRemainingTokens', 'contextUsed', 'branch', 'context', 'contextUsedPercent'];
  context.items = items;
  run('setStatusItems(items)');
  assert.deepEqual(sent.at(-1).items, items);
  Object.assign(context.state, { contextUsedTokens: 25, contextWindowTokens: 100 });
  assert.equal(run('statusLabel("context")'), 'Ctx left 75%');
  assert.equal(run('statusLabel("contextUsed")'), 'Ctx used 25 tokens');
  assert.equal(run('statusLabel("contextRemainingTokens")'), 'Ctx left 75 tokens');
  assert.equal(run('statusLabel("contextUsedPercent")'), 'Ctx used 25%');
  context.state.contextUsedTokens = 150;
  assert.equal(run('statusLabel("contextRemainingTokens")'), 'Ctx left 0 tokens');
  assert.equal(run('statusLabel("contextUsedPercent")'), 'Ctx used 150%');
  context.state.contextUsedTokens = 0;
  assert.equal(run('statusLabel("contextRemainingTokens")'), 'Ctx left 100 tokens');
  assert.equal(run('statusLabel("contextUsedPercent")'), 'Ctx used 0%');
  for (const window of [undefined, 0]) {
    context.state.contextWindowTokens = window;
    assert.equal(run('statusLabel("contextRemainingTokens")'), 'Ctx left — tokens');
    assert.equal(run('statusLabel("contextUsedPercent")'), 'Ctx used —');
    assert.equal(run('statusLabel("contextUsed")'), 'Ctx used 0 tokens');
  }
  context.state.contextWindowTokens = 100;
  context.state.contextUsedTokens = undefined;
  assert.equal(run('statusLabel("contextRemainingTokens")'), 'Ctx left — tokens');
  assert.equal(run('statusLabel("contextUsedPercent")'), 'Ctx used —');
});

test("usage updates preserve unknown Content values and independent Weekly data", () => {
  const { run, context } = harness();
  run(section('  function safePercentOrUndefined(', '  function normalizeSettingValue('));
  const update = section('      case "context.usage":', '      case "run.activity":');
  context.message = { type: 'context.usage', usedTokens: -1, contextWindowTokens: 100, weeklyUsedPercent: 25 };
  run('switch (message.type) {\n' + update + '\n}');
  assert.equal(run('statusLabel("context")'), 'Ctx left —');
  assert.equal(run('statusLabel("contextUsed")'), 'Ctx used — tokens');
  assert.equal(run('statusLabel("weeklyRemaining")'), 'Wk left 75%');
  context.message = { type: 'context.usage', usedTokens: 0, contextWindowTokens: 100 };
  run('switch (message.type) {\n' + update + '\n}');
  assert.equal(run('statusLabel("context")'), 'Ctx left 100%');
  assert.equal(run('statusLabel("weekly")'), 'Wk used —');
  assert.equal(run('statusLabel("weeklyRemaining")'), 'Wk left —');
});

async function load(relative) {
  const output = await build({ entryPoints: [new URL('../../' + relative, import.meta.url).pathname], bundle: true, write: false, platform: 'node', format: 'esm' });
  return import('data:text/javascript;base64,' + Buffer.from(output.outputFiles[0].text).toString('base64'));
}

test("host config and protocol accept the complete catalog and reject malformed messages", async () => {
  const { resolveStatusItems } = await load('src/core/config/resolver.ts');
  const { parseClientMessage } = await load('src/protocol/validator.ts');
  const { run } = harness();
  const catalog = clean(run('Object.keys(statusCatalog)'));
  assert.deepEqual(resolveStatusItems(catalog), catalog);
  assert.deepEqual(resolveStatusItems([]), []);
  assert.deepEqual(resolveStatusItems(['queue', 'bad', 'queue', 'elapsed']), ['queue', 'elapsed']);
  assert.equal(parseClientMessage({ type: 'status.reorder', items: ['queue', 'queue'] }), undefined);
  assert.equal(parseClientMessage({ type: 'status.reorder', items: ['bad'] }), undefined);
  assert.deepEqual(parseClientMessage({ type: 'status.reorder', items: [] }).items, []);
  assert.deepEqual(parseClientMessage({ type: 'status.reorder', items: catalog }).items, catalog);
  const manifest = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'));
  assert.deepEqual([...manifest.contributes.configuration.properties['agentFactory.mainChat.statusItems'].items.enum].sort(), catalog.sort());
});

test("host initialization replaces stale restored selection, including an intentionally empty bar", () => {
  const { run, context } = harness();
  context.document.body = { dataset: {} };
  Object.assign(context, {
    message: { type: 'host.initialize', statusItems: [], runtimeAvailable: true, running: false, role: 'main', model: '', taskMode: 'work', queueCount: 0 },
    normalizeModel: value => value || '', normalizeSettingValue: value => value,
    businessModeNames: { normal: "Normal" },
    settingOptions: { reasoning: [] }, safePercentOrUndefined: () => undefined,
    safeCount: value => Number.isInteger(value) ? value : 0,
    updateModeControls() {}, renderTimeline() {}, updateRunControls() {}
  });
  const initialize = section('      case "host.initialize":', '      case "syntax.theme":');
  run('switch (message.type) {\n' + initialize + '\n}');
  assert.deepEqual(clean(context.state.statusItems), []);
  context.message.statusItems = ['elapsed', 'branch'];
  run('switch (message.type) {\n' + initialize + '\n}');
  assert.deepEqual(clean(context.state.statusItems), ['elapsed', 'branch']);
});

test("catalog dragging uses vertical insertion and cancelled dragging clears the drop target", () => {
  const { context, run, element, sent } = harness();
  context.source = element(); context.target = element();
  run('bindStatusDrag(source, "queue", true); bindStatusDrag(target, "project", true)');
  const data = new Map();
  const event = { clientY: 5, dataTransfer: { setData: (key, value) => data.set(key, value), getData: key => data.get(key) }, preventDefault() {}, stopPropagation() {} };
  context.source.handlers.dragstart(event);
  context.target.handlers.dragover(event);
  assert.equal(context.target.classList.contains('status-drop-before'), true);
  context.source.handlers.dragend();
  assert.equal(context.target.classList.contains('status-drop-before'), false);
  assert.equal(sent.length, 0);
  context.source.handlers.dragstart(event);
  context.target.handlers.drop(event);
  assert.deepEqual(sent.at(-1).items, ['queue', 'project', 'branch']);
});
