import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ts from "typescript";

// A message whose `type` one side does not know is dropped without an error the user can act on.
// Each direction therefore has one authoritative list, the union in src/protocol/messages.ts as the
// type checker resolves it, and every other place that spells a type is compared with that list.

const root = new URL("../../", import.meta.url);
const messagesPath = "src/protocol/messages.ts";
const validatorPath = "src/protocol/validator.ts";
const panelManagerPath = "src/infrastructure/vscode/chat-panel-manager.ts";
const contractPanelPath = "src/infrastructure/vscode/contract-panel.ts";

/** The chat webview: chat.js and its feature modules. Its requests go through parseClientMessage. */
const isChatSource = path => path === "static/js/chat.js" || /^static\/js\/chat\/[^/]+\.js$/.test(path);
/** The contract panel is a second webview whose host reads its requests without parseClientMessage. */
const contractSource = "static/js/contracts.js";
const centerSource = "static/js/control-center.js";
// Archify is a custom editor with its own host message handler.
const archifySource = "static/js/archify.js";

// Known mismatches. An entry names the type, where it is spelled and why it is tolerated; an entry
// that no longer describes the source fails the test, so these lists cannot go stale.

/** Sent by the chat webview, rejected by parseClientMessage. */
const sentButNotValidated = [];
/** Named in the validator's allow-list or in its switch, but not in both. */
const validatorListDisagreements = [];
/** Accepted by parseClientMessage, without a case in handleMessage. */
const validatedButNotHandled = [];
/** Accepted by parseClientMessage but absent from ClientMessage, or declared there and never accepted. */
const clientDeclarationDisagreements = [];
/** Handled by the chat webview, absent from HostMessage. */
const handledButNotDeclared = [];
/** Declared in HostMessage and deliberately ignored by the chat webview. */
const intentionallyUnhandled = [];

/**
 * postMessage arguments whose `type` is not a literal (a variable, a helper parameter) or that spread a
 * variable after `type`, which could replace it.
 * Key: "<file> <argument source>"; value: every type that call can send.
 */
const dynamicSends = {
  // chat.js submitMessage: `message` holds id, text and settings and no `type`, so the spread cannot rename the request.
  'static/js/chat.js { type: "chat.send", ...message }': ["chat.send"],
  // bot.js saveBotPrompt: botPromptPending is assigned { requestId, prompt, character } on the preceding lines.
  'static/js/chat/bot.js { type: "bot.prompt.save", ...botPromptPending }': ["bot.prompt.save"],
  // work-units.js: the click handlers of a loop over ["create", "merge", "refresh"].
  'static/js/chat/work-units.js { type: "worktree." + action }': ["worktree.create", "worktree.merge", "worktree.refresh"],
  // task-flow.js: target holds only the validated task-deletion target fields.
  'static/js/chat/task-flow.js { type: "task.delete", ...target }': ["task.delete"],
  // maestro.js sendDomainEdit: `edit` is one of the three literal domain edits built by its callers.
  'static/js/chat/maestro.js { ...edit, revision: registry().revision }': ["domain.create", "domain.rename", "domain.assign"],
  // maestro.js workerAction: `message` is one of the literal worker actions built by the worker detail.
  'static/js/chat/maestro.js message': ["worker.command", "worker.stop", "worker.remove", "worker.handoff"]
};

const usedDynamicSends = new Set();

const sources = new Map();
function parse(path) {
  if (!sources.has(path)) {
    const text = readFileSync(new URL(path, root), "utf8");
    sources.set(path, ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS));
  }
  return sources.get(path);
}

function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}

function find(node, accept, label) {
  let found;
  walk(node, candidate => { if (!found && accept(candidate)) found = candidate; });
  assert.ok(found, `${label} was not found; update the extractor in this test`);
  return found;
}

const where = node => `${node.getSourceFile().fileName}:${node.getSourceFile().getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
const unique = values => [...new Set(values)].sort();
const difference = (left, right) => unique(left).filter(value => !right.includes(value));

/** Every string an expression can evaluate to, or undefined when it is not a literal choice. */
function literals(expression) {
  if (ts.isParenthesizedExpression(expression)) return literals(expression.expression);
  if (ts.isStringLiteralLike(expression)) return [expression.text];
  if (ts.isConditionalExpression(expression)) {
    const [yes, no] = [literals(expression.whenTrue), literals(expression.whenFalse)];
    return yes && no ? [...yes, ...no] : undefined;
  }
  return undefined;
}

/**
 * A broken pattern must not pass as "nothing to compare": an extractor has to find something, and at
 * least half of what a plain text search for the same construct counts in the same source.
 */
function extracted(label, types, node, pattern) {
  const crude = new Set([...node.getText().matchAll(pattern)].map(match => match[1])).size;
  assert.ok(types.length > 0, `${label}: the extractor found no types`);
  assert.ok(types.length * 2 >= crude, `${label}: the extractor found ${types.length} types where the source text has ${crude}`);
  return unique(types);
}

const casePattern = /\bcase\s+["']([^"']+)["']\s*:/g;

/** Case labels of every `switch (<subject>)` below a node. */
function switchCases(label, node, subject) {
  const types = [];
  walk(node, candidate => {
    if (!ts.isSwitchStatement(candidate) || candidate.expression.getText() !== subject) return;
    for (const clause of candidate.caseBlock.clauses) {
      if (!ts.isCaseClause(clause)) continue;
      const values = literals(clause.expression);
      assert.ok(values, `${label}: ${where(clause)} has a case that is not a string literal`);
      types.push(...values);
    }
  });
  return extracted(label, types, node, casePattern);
}

/** Literals compared with `<subject>` through ===, !==, == or != below a node. */
function comparedTypes(node, subject) {
  const operators = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken,
    ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];
  const types = [];
  walk(node, candidate => {
    if (!ts.isBinaryExpression(candidate) || !operators.includes(candidate.operatorToken.kind)) return;
    for (const [side, other] of [[candidate.left, candidate.right], [candidate.right, candidate.left]]) {
      if (subject.test(side.getText()) && literals(other)) types.push(...literals(other));
    }
  });
  return types;
}

/** True when a spread operand is written out as object literals that hold no `type`. */
function spreadsNoType(expression) {
  if (ts.isParenthesizedExpression(expression)) return spreadsNoType(expression.expression);
  if (ts.isConditionalExpression(expression)) return spreadsNoType(expression.whenTrue) && spreadsNoType(expression.whenFalse);
  return ts.isObjectLiteralExpression(expression) && expression.properties.every(item =>
    !ts.isSpreadAssignment(item) && item.name && !ts.isComputedPropertyName(item.name) && item.name.getText().replace(/["']/g, "") !== "type");
}

/** Types passed to `<anything>.postMessage(...)` in one file, with every call site accounted for. */
function sentTypes(path) {
  const source = parse(path);
  const types = [];
  let calls = 0;
  walk(source, node => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== "postMessage") return;
    calls += 1;
    const argument = node.arguments[0];
    const property = argument && ts.isObjectLiteralExpression(argument)
      ? argument.properties.find(item => ts.isPropertyAssignment(item) && item.name.getText().replace(/["']/g, "") === "type") : undefined;
    // Only a spread written after `type` can replace it.
    const renamed = property && argument.properties.slice(argument.properties.indexOf(property) + 1)
      .some(item => ts.isSpreadAssignment(item) && !spreadsNoType(item.expression));
    const values = property && !renamed ? literals(property.initializer) : undefined;
    if (values) return void types.push(...values);
    const key = `${path} ${argument ? argument.getText().replace(/\s+/g, " ") : ""}`;
    assert.ok(Object.hasOwn(dynamicSends, key),
      `${where(node)} sends a message whose type is not a literal; list the types it can send in dynamicSends under ${JSON.stringify(key)}`);
    usedDynamicSends.add(key);
    types.push(...dynamicSends[key]);
  });
  // A call the syntax walk does not see (an alias, a renamed helper) would otherwise go unchecked.
  const textual = [...source.text.matchAll(/\bpostMessage\s*\(/g)].length;
  assert.equal(calls, textual, `${path}: ${textual} postMessage( occurrences in the text, ${calls} recognized as calls`);
  return types;
}

function staticScripts() {
  return readdirSync(new URL("static/js/", root), { recursive: true })
    .map(name => "static/js/" + String(name).replaceAll("\\", "/")).filter(name => name.endsWith(".js")).sort();
}

/** The `type` literals of an exported union in messages.ts, with imported and intersected members resolved. */
function declaredTypes(alias) {
  const config = fileURLToPath(new URL("tsconfig.json", root));
  const { options } = ts.getParsedCommandLineOfConfigFile(config, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(String(diagnostic.messageText)); } });
  const file = fileURLToPath(new URL(messagesPath, root));
  const program = declaredTypes.program ??= ts.createProgram([file], { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const declaration = find(program.getSourceFile(file), node => ts.isTypeAliasDeclaration(node) && node.name.text === alias, alias);
  const union = checker.getTypeAtLocation(declaration.name);
  const types = [];
  for (const member of union.isUnion() ? union.types : [union]) {
    const property = checker.getPropertyOfType(member, "type");
    assert.ok(property, `${alias}: member ${checker.typeToString(member)} has no type property`);
    const type = checker.getTypeOfSymbol(property);
    for (const literal of type.isUnion() ? type.types : [type]) {
      assert.ok(literal.isStringLiteral(), `${alias}: type ${checker.typeToString(literal)} is not a string literal`);
      types.push(literal.value);
    }
  }
  return extracted(alias, types, declaration, /\btype: ((?:"[^"]+"(?: \| )?)+)/g);
}

/** Fails on a mismatch that is not listed, and on a listed one that no longer occurs. */
function assertOnly(label, mismatches, exceptions) {
  assert.deepEqual(unique(mismatches), unique(exceptions.map(item => item.type)), label);
}

test("every chat request type is sent, validated, handled and declared under the same name", function () {
  const scripts = staticScripts();
  const chatScripts = scripts.filter(isChatSource);
  const sendingScripts = scripts.filter(path => /\bpostMessage\b/.test(parse(path).text));
  // A new script that posts messages must be assigned to a channel before its types can be checked.
  assert.deepEqual(difference(sendingScripts, [...chatScripts, contractSource, centerSource, archifySource]), []);
  const sent = unique([...chatScripts, centerSource].flatMap(sentTypes));
  assert.ok(sent.length > 0, "the chat webview sends no types");
  assert.deepEqual(difference(Object.keys(dynamicSends), [...usedDynamicSends]), [], "dynamicSends lists a call that no longer exists");

  const validator = parse(validatorPath);
  const allowList = find(validator, node => ts.isVariableDeclaration(node) && node.name.getText() === "clientMessageTypes", "clientMessageTypes");
  const allowed = [];
  walk(allowList.initializer, node => {
    if (!ts.isArrayLiteralExpression(node)) return;
    for (const element of node.elements) {
      assert.ok(literals(element), `${where(element)}: clientMessageTypes holds a value that is not a string literal`);
      allowed.push(...literals(element));
    }
  });
  const parser = find(validator, node => ts.isFunctionDeclaration(node) && node.name?.text === "parseClientMessage", "parseClientMessage");
  const parsed = switchCases("parseClientMessage", parser, "value.type");
  assert.ok(allowed.length > 0 && allowed.length * 2 >= parsed.length, `clientMessageTypes: ${allowed.length} types for ${parsed.length} parser cases`);
  assert.equal(allowed.length, new Set(allowed).size, "clientMessageTypes repeats a type");
  // parseClientMessage rejects a type missing from the allow-list first and one without a case last.
  const accepted = unique(allowed).filter(type => parsed.includes(type));
  assertOnly("validator allow-list and parser cases disagree", [...difference(allowed, parsed), ...difference(parsed, allowed)], validatorListDisagreements);

  const handler = find(parse(panelManagerPath), node => ts.isMethodDeclaration(node) && node.name.getText() === "handleMessage", "handleMessage");
  const handled = switchCases("handleMessage", handler, "message.type");
  const declared = declaredTypes("ClientMessage");

  assertOnly("sent by the chat webview but rejected by parseClientMessage", difference(sent, accepted), sentButNotValidated);
  assertOnly("accepted by parseClientMessage but not handled by handleMessage", difference(accepted, handled), validatedButNotHandled);
  assertOnly("parseClientMessage and the ClientMessage union disagree",
    [...difference(accepted, declared), ...difference(declared, accepted)], clientDeclarationDisagreements);
});

test("every host message type is declared and either handled by the chat webview or listed as unhandled", function () {
  const chat = parse("static/js/chat.js");
  const listener = find(chat, node => ts.isCallExpression(node) && node.expression.getText() === "window.addEventListener"
    && literals(node.arguments[0])?.[0] === "message", "the chat message listener");
  const dispatched = switchCases("chat message listener", listener, "message.type");
  // Feature modules branch again on the message they were handed.
  const compared = staticScripts().filter(isChatSource).flatMap(path => comparedTypes(parse(path), /^message\??\.type$/));
  const handled = unique([...dispatched, ...compared]);
  const declared = declaredTypes("HostMessage");

  assertOnly("handled by the chat webview but absent from HostMessage", difference(handled, declared), handledButNotDeclared);
  assertOnly("declared in HostMessage but not handled by the chat webview", difference(declared, handled), intentionallyUnhandled);
});

test("the contract panel and its webview use the same message types", function () {
  const panel = parse(contractPanelPath);
  const webview = parse(contractSource);
  const requested = unique(sentTypes(contractSource));
  const answered = unique(sentTypes(contractPanelPath));
  assert.ok(requested.length > 0 && answered.length > 0, "the contract panel exchanges no types");
  assert.deepEqual(requested, unique(comparedTypes(panel, /^message\??\.type$/)));
  assert.deepEqual(answered, unique(comparedTypes(webview, /^message\??\.type$/)));
});
