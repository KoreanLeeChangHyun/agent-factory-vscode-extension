import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { importTypeScript } from "../support/import-typescript.mjs";

const { ConductorQueueChannel } = await importTypeScript("src/infrastructure/agent-factory/conductor-queue-client.ts");
const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");
test("canonical question and area controls preserve exact identities and reject incomplete answers", () => {
  const message = { type: "conductor.control", action: "answer-question", requestId: "req-one", questionId: "question-one", expectedVersion: 2, text: "table" };
  assert.deepEqual(parseClientMessage(message), message);
  assert.equal(parseClientMessage({ ...message, questionId: undefined }), undefined);
  assert.equal(parseClientMessage({ ...message, expectedVersion: 0 }), undefined);
  assert.equal(parseClientMessage({ ...message, text: " " }), undefined);
  const area = { type: "conductor.control", action: "resolve-area", inputId: "input-one", area: { domainId: "domain-one", subdomainId: "sub-one" } };
  assert.deepEqual(parseClientMessage(area), area);
  assert.equal(parseClientMessage({ ...area, area: { domainId: "domain-one" } }), undefined);
  assert.equal(parseClientMessage({ ...area, area: { domainId: "../bad", subdomainId: "sub-one" } }), undefined);
});

// A stand-in for conductor_queue.py serve: replies by id, streams one feed line, exits on "crash".
const FAKE_RUNTIME = `
const lines = require("readline").createInterface({ input: process.stdin });
const write = value => process.stdout.write(JSON.stringify(value) + "\\n");
write({ type: "role", role: "leader" });
lines.on("line", line => {
  const message = JSON.parse(line);
  if (message.op === "crash") { process.stderr.write("simulated crash"); process.exit(3); }
  if (message.op === "never") return;
  if (message.op === "fail") { write({ type: "reply", id: message.id, ok: false, error: { code: "chat_conflict", message: "conflict" } }); return; }
  write({ type: "feed", cursor: 7, entries: [{ id: 7, chatId: message.chatId, kind: "chat", key: "k", version: 1, payload: {}, eventSeq: 1, eventAt: 1, appliedAt: 1 }], emittedAt: 1 });
  write({ type: "reply", id: message.id, ok: true, result: { echo: message.op, chatId: message.chatId } });
});
lines.on("close", () => process.exit(0));
`;

async function fakeRuntime(t) {
  const directory = await mkdtemp(join(tmpdir(), "af-conductor-queue-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = join(directory, "serve.cjs");
  await writeFile(script, FAKE_RUNTIME);
  let starts = 0;
  const channel = new ConductorQueueChannel(async () => { starts++; return { executable: process.execPath, args: [script], env: process.env }; });
  t.after(() => channel.dispose());
  return { channel, starts: () => starts };
}

test("the channel correlates replies, streams feed lines and restarts lazily after an exit", async t => {
  const { channel, starts } = await fakeRuntime(t);
  const lines = [];
  channel.onLine(line => lines.push(line));
  assert.deepEqual(await channel.request("snapshot", { chatId: "c" }), { echo: "snapshot", chatId: "c" });
  assert.ok(lines.some(line => line.type === "feed" && line.entries[0].chatId === "c"));
  assert.equal(channel.role, "leader");
  await assert.rejects(channel.request("fail"), error => error.code === "chat_conflict");
  const pending = channel.request("never");
  await assert.rejects(Promise.all([pending, channel.request("crash")]), /simulated crash/);
  assert.equal(channel.role, "disconnected");
  assert.ok(lines.some(line => line.type === "role" && line.role === "disconnected"));
  assert.deepEqual(await channel.request("snapshot", { chatId: "d" }), { echo: "snapshot", chatId: "d" });
  assert.equal(starts(), 2);
});

test("conductor controls carry exact identifiers and the version the user saw", () => {
  assert.deepEqual(parseClientMessage({ type: "conductor.control", action: "cancel", requestId: "req-1", expectedVersion: 3 }),
    { type: "conductor.control", action: "cancel", requestId: "req-1", expectedVersion: 3 });
  assert.deepEqual(parseClientMessage({ type: "conductor.control", action: "resolve-input", inputId: "in-1", relation: "followup", requestId: "req-2" }),
    { type: "conductor.control", action: "resolve-input", inputId: "in-1", relation: "followup", requestId: "req-2" });
  for (const invalid of [
    { type: "conductor.control", action: "cancel", requestId: "req-1" },
    { type: "conductor.control", action: "approve", expectedVersion: 1 },
    { type: "conductor.control", action: "reassign", requestId: "req-1", expectedVersion: 1 },
    { type: "conductor.control", action: "cancel", requestId: "../x", expectedVersion: 1 },
    { type: "conductor.control", action: "resolve-input", inputId: "in-1" },
    { type: "conductor.control", action: "cancel", delegationId: "d", expectedVersion: 0 }
  ]) assert.equal(parseClientMessage(invalid), undefined, JSON.stringify(invalid));
  assert.deepEqual(parseClientMessage({ type: "conductor.resync" }), { type: "conductor.resync" });
});

class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.dataset = {}; this.listeners = {}; this.hidden = false; this.textContent = ""; this.title = ""; this.className = ""; }
  get classList() { const self = this; return { add(...names) { self.className = [self.className, ...names].filter(Boolean).join(" "); } }; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  before(node) { this.parent?.children.splice(this.parent.children.indexOf(this), 0, node); }
  addEventListener(name, listener) { this.listeners[name] = listener; }
  click() { this.listeners.click?.(); }
  get text() { return [this.textContent, ...this.children.map(child => child.text)].join(" "); }
  find(predicate) { if (predicate(this)) return this; for (const child of this.children) { const found = child.find(predicate); if (found) return found; } return undefined; }
}

async function webview() {
  const source = await readFile(new URL("../../static/js/chat/conductor-queue.js", import.meta.url), "utf8");
  const body = new Element("body");
  const region = new Element("section");
  region.parent = body;
  body.children.push(region);
  const document = {
    createElement: tag => new Element(tag),
    getElementById: id => body.find(node => node.id === id),
    querySelector: selector => selector === ".composer-region" ? region : undefined,
    body
  };
  const posted = [];
  const context = vm.createContext({ globalThis: {}, document, setTimeout, clearTimeout, Date });
  context.globalThis = context;
  vm.runInContext(source, context);
  const state = { timeline: [], pendingRequests: [{ id: "m1" }] };
  let renders = 0;
  const queue = context.AgentFactoryChat.conductorQueue({
    state, vscode: { postMessage: message => posted.push(message) }, renderAll: () => { renders++; }, persist: () => {},
    t: (key, ...values) => [key, ...values].join(":"), renderAssistant: (content, event) => { content.textContent = event.text; }
  });
  return { queue, state, posted, body, renders: () => renders };
}

const entry = (id, kind, key, version, payload) => ({ id, chatId: "panel-1", kind, key, version, payload, eventSeq: id, eventAt: Date.now() / 1000, appliedAt: Date.now() / 1000 });

test("the webview applies a snapshot, buffers early feed rows, drops reconnect duplicates and never regresses state", async () => {
  const { queue, state, posted, body } = await webview();
  queue.receive({ type: "conductor.state", enabled: true, role: "leader" });
  queue.receive({ type: "conductor.accepted", id: "m1", text: "hello", acceptedAt: "2026-10-12T00:00:00Z", inputId: "in-1" });
  assert.deepEqual(state.pendingRequests, []);
  assert.equal(state.timeline[0].id, "m1");
  const request = { id: "req-1", conductorId: "cond-1", title: "hello", status: "planning", version: 2, receivedAt: 1 };
  const snapshot = { cursor: 5, state: [
    { key: "conductor:cond-1", kind: "conductor", version: 1, payload: { id: "cond-1", ordinal: 1 } },
    { key: "request:req-1", kind: "request", version: 4, payload: request }
  ], chat: [entry(1, "chat", "chat:e1", 1, { role: "user", text: "hello", clientMessageId: "m1", acceptedAt: 1 }),
            entry(4, "chat", "chat:e4", 4, { role: "assistant", text: "Under", messageKey: "k1", chunk: true, requestId: "req-1", conductorId: "cond-1" })] };
  // A resync was requested: rows streamed before the snapshot arrives are buffered, then applied after its cursor.
  queue.receive({ type: "conductor.state", enabled: true, role: "disconnected" });
  queue.receive({ type: "conductor.state", enabled: true, role: "leader" });
  queue.receive({ type: "conductor.feed", cursor: 6, entries: [
    entry(5, "chat", "chat:e5", 5, { role: "assistant", text: "DUPLICATE", messageKey: "k1", chunk: true, requestId: "req-1", conductorId: "cond-1" }),
    entry(6, "chat", "chat:e6", 6, { role: "assistant", text: "stood.", messageKey: "k1", chunk: true, requestId: "req-1", conductorId: "cond-1" })] });
  queue.receive({ type: "conductor.snapshot", snapshot });
  const reply = state.timeline.find(item => item.id === "cq-k1");
  assert.equal(reply.text, "Understood.");
  assert.equal(state.timeline.filter(item => item.type === "user").length, 1);
  queue.receive({ type: "conductor.feed", cursor: 7, entries: [
    entry(6, "chat", "chat:e6", 6, { role: "assistant", text: "stood.", messageKey: "k1", chunk: true }),
    entry(7, "state", "request:req-1", 3, { ...request, status: "accepted", version: 1 }),
    entry(8, "chat", "chat:e8", 8, { role: "assistant", text: "Understood fully.", messageKey: "k1", chunk: false, final: false, requestId: "req-1", conductorId: "cond-1" })] });
  assert.equal(reply.text, "Understood fully.");
  assert.equal(reply.streaming, false);
  assert.equal(queue.requests()[0].status, "planning");
  assert.equal(queue.cursor, 8);
  assert.ok(queue.lagMs >= 0);
  const board = body.find(node => node.id === "conductor-queue-board");
  assert.match(board.text, /conductorQueue\.lag/);
  board.find(node => node.className.includes("conductor-queue-cancel")).click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { type: "conductor.control", action: "cancel", requestId: "req-1", expectedVersion: 2 });
  assert.ok(posted.some(message => message.type === "conductor.resync"));
});

test("an ambiguous message renders follow-up and new-request choices bound to the held input", async () => {
  const { queue, state, posted } = await webview();
  queue.receive({ type: "conductor.state", enabled: true, role: "leader" });
  queue.receive({ type: "conductor.snapshot", snapshot: { cursor: 0, state: [], chat: [] } });
  queue.receive({ type: "conductor.feed", cursor: 3, entries: [entry(3, "chat", "chat:e3", 3, { role: "question", question: "relation", inputId: "in-9",
    candidates: [{ requestId: "req-1", title: "first" }, { requestId: "req-2", title: "second" }] })] });
  const item = state.timeline.find(value => value.type === "conductor");
  const content = new Element("div");
  queue.renderEntry(content, item);
  const buttons = [];
  content.find(node => { if (node.tagName === "button") buttons.push(node); return false; });
  assert.equal(buttons.length, 3);
  buttons[1].click();
  buttons[2].click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.slice(-2))), [
    { type: "conductor.control", action: "resolve-input", requestId: "req-2", inputId: "in-9", relation: "followup" },
    { type: "conductor.control", action: "resolve-input", inputId: "in-9", relation: "new" }]);
  queue.receive({ type: "conductor.state", enabled: false });
  assert.equal(state.timeline.some(value => value.type === "conductor"), false);
});

test("intent plans persist count, dependency reasons and worker answers target the exact delegation", async () => {
  const { queue, state, posted, body } = await webview();
  queue.receive({ type: "conductor.state", enabled: true, role: "leader" });
  const plan = { requestId: "req-parent", count: 2, intents: [
    { title: "a", parallelCandidate: true, reason: "separate files", admissionReason: "independent-scopes", dependencies: [] },
    { title: "b", parallelCandidate: false, reason: "uses a", admissionReason: "dependency", dependencies: ["req-a"] }
  ] };
  queue.receive({ type: "conductor.snapshot", snapshot: { cursor: 4, state: [
    { key: "plan:req-parent", version: 1, payload: plan },
    { key: "worker:del-a", version: 2, payload: { id: "del-a", requestId: "req-a", status: "awaiting-answer", version: 3, chatId: "panel-1" } }
  ], chat: [entry(3, "chat", "chat:plan", 1, { ...plan, role: "plan" }),
    entry(4, "chat", "chat:question", 2, { role: "question", question: "worker", text: "Which format?", requestId: "req-a", delegationId: "del-a" })] } });
  assert.match(body.text, /conductorQueue.intents:2/);
  assert.match(body.text, /conductorQueue.dependencies:req-a/);
  const planItem = state.timeline.find(item => item.kind === "plan");
  const summary = new Element("div");
  queue.renderEntry(summary, planItem);
  assert.match(summary.text, /separate files/);
  const question = new Element("div");
  queue.renderEntry(question, state.timeline.find(item => item.kind === "question"));
  question.find(node => node.tagName === "input").value = "table";
  question.find(node => node.tagName === "button").click();
  assert.deepEqual(JSON.parse(JSON.stringify(posted.at(-1))), { type: "conductor.control", action: "answer-worker", delegationId: "del-a", expectedVersion: 3, chatId: "panel-1", text: "table" });
  assert.equal(parseClientMessage({ type: "conductor.control", action: "answer-worker", delegationId: "del-a", expectedVersion: 3, text: "" }), undefined);
  assert.equal(parseClientMessage(posted.at(-1)).text, "table");
});

test("composer follow-ups preserve the selected request and reject malformed targets", () => {
  const message = { type: "chat.send", id: "m", text: "refine this", attachments: [], execution: { fast: false, goal: false } };
  assert.deepEqual(parseClientMessage({ ...message, conductorTarget: { relation: "followup", requestId: "req-one" } }).conductorTarget,
    { relation: "followup", requestId: "req-one" });
  assert.deepEqual(parseClientMessage({ ...message, conductorTarget: { relation: "new" } }).conductorTarget, { relation: "new" });
  for (const target of [{ relation: "followup" }, { relation: "followup", requestId: "../escape" }, { relation: "new", requestId: "req-one" }])
    assert.equal(parseClientMessage({ ...message, conductorTarget: target }), undefined);
});
