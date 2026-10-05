import { readdirSync, readFileSync } from "node:fs";
import { isContext, runInContext, runInNewContext } from "node:vm";

const directory = new URL("../../static/js/", import.meta.url);
// Test workers inspect immutable checkout sources. Keep only the source string;
// every harness still owns its mutable VM context. A new run reads the files again.
let chatSource;

/** chat.js followed by its feature modules, for checks that inspect or slice chat source text. */
export function readChatSourceSync() {
  if (chatSource !== undefined) return chatSource;
  const modules = readdirSync(new URL("chat/", directory)).filter(name => name.endsWith(".js")).sort().map(name => "chat/" + name);
  chatSource = ["chat.js", ...modules].map(name => readFileSync(new URL(name, directory), "utf8")).join("\n");
  return chatSource;
}

/** chat.css followed by its feature stylesheets in the order the template loads them. */
export function readChatStylesSync() {
  const template = readFileSync(new URL("../../templates/chat.html", import.meta.url), "utf8");
  const names = [...template.matchAll(/href="\{\{chatStyleBaseUri\}\}\/(chat\/[a-z-]+\.css)"/g)].map(match => match[1]);
  return ["chat.css", ...names].map(name => readFileSync(new URL("../css/" + name, directory), "utf8")).join("\n");
}

export async function readChatSource() {
  return readChatSourceSync();
}

const featureInstances = [...readFileSync(new URL("chat.js", directory), "utf8")
  .matchAll(/^ {2}const (chat[A-Z]\w*) = globalThis\.AgentFactoryChat\./gm)].map(match => match[1]);

/**
 * chat.js reaches an extracted feature through its instance (`chatNotes.receiveNotes`),
 * and a feature reaches late chat.js state through `host`. Isolated harnesses stub or
 * define those members directly on the context, so each missing name forwards to the
 * context itself.
 */
// `const`/`let` declared by an evaluated section are not properties of the context object.
function lexicalBinding(context, key) {
  if (typeof key !== "string" || !/^[A-Za-z_$][\w$]*$/.test(key) || !isContext(context)) return undefined;
  try { return runInContext(key, context); } catch { return undefined; }
}

export function withChatFeatures(context) {
  for (const name of [...featureInstances, "host"]) {
    if (name in context) continue;
    context[name] = new Proxy({}, {
      get: (_target, key) => key in context ? context[key] : lexicalBinding(context, key),
      set: (_target, key, value) => { context[key] = value; return true; },
      has: (_target, key) => key in context
    });
  }
  return context;
}

export function runChatInNewContext(source, context = {}, options) {
  return runInNewContext(source, withChatFeatures(context), options);
}
