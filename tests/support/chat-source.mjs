import { readdirSync, readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const directory = new URL("../../static/js/", import.meta.url);

/** chat.js followed by its feature modules, for checks that inspect or slice chat source text. */
export function readChatSourceSync() {
  const modules = readdirSync(directory).filter(name => /^chat-[a-z-]+\.js$/.test(name)).sort();
  return ["chat.js", ...modules].map(name => readFileSync(new URL(name, directory), "utf8")).join("\n");
}

export async function readChatSource() {
  return readChatSourceSync();
}

const featureInstances = [...readFileSync(new URL("chat.js", directory), "utf8")
  .matchAll(/^  const (chat[A-Z]\w*) = globalThis\.AgentFactoryChat\./gm)].map(match => match[1]);

/**
 * chat.js reaches an extracted feature through its instance (`chatNotes.receiveNotes`),
 * and a feature reaches late chat.js state through `host`. Isolated harnesses stub or
 * define those members directly on the context, so each missing name forwards to the
 * context itself.
 */
export function withChatFeatures(context) {
  for (const name of [...featureInstances, "host"]) {
    if (name in context) continue;
    context[name] = new Proxy({}, {
      get: (_target, key) => context[key],
      set: (_target, key, value) => { context[key] = value; return true; },
      has: (_target, key) => key in context
    });
  }
  return context;
}

export function runChatInNewContext(source, context = {}, options) {
  return runInNewContext(source, withChatFeatures(context), options);
}
