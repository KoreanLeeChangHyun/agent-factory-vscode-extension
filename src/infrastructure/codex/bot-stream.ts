import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { claudeExecutable, codexExecutable, runtimeEnvironment } from "../agent-factory/process-environment";

/** Decode only the reply string, leaving incomplete escapes for the next chunk. */
export function partialBotReply(json: string): string {
  const match = /"reply"\s*:\s*"/.exec(json);
  if (!match) return "";
  let result = "";
  for (let i = match.index + match[0].length; i < json.length; i++) {
    const char = json[i];
    if (char === '"') break;
    if (char !== "\\") { result += char; continue; }
    const escaped = json[++i];
    if (!escaped) break;
    if (escaped === "u") {
      const code = json.slice(i + 1, i + 5);
      if (!/^[0-9a-f]{4}$/i.test(code)) break;
      result += String.fromCharCode(parseInt(code, 16)); i += 4;
    } else {
      const values: Record<string, string> = { '"': '"', "\\": "\\", "/": "/", n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
      if (!(escaped in values)) break;
      result += values[escaped];
    }
  }
  return /[\uD800-\uDBFF]$/.test(result) ? result.slice(0, -1) : result;
}

export async function streamBotTurn(provider: "codex" | "claude", prompt: string, schema: object,
  model: string, cwd: string, signal: AbortSignal, publish: (text: string) => void): Promise<string> {
  const args = provider === "codex"
    ? ["app-server", "--disable", "shell_tool", "--disable", "apps", "--disable", "multi_agent",
      "-c", "mcp_servers={}", "-c", 'web_search="disabled"']
    : ["-p", "--model", model, "--tools", "", "--setting-sources", "", "--strict-mcp-config",
      "--no-session-persistence", "--permission-mode", "dontAsk", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages", "--json-schema", JSON.stringify(schema)];
  return new Promise<string>((resolve, reject) => {
    const child = spawn(provider === "codex" ? codexExecutable() : claudeExecutable(), args,
      { cwd, env: runtimeEnvironment(), signal, stdio: ["pipe", "pipe", "ignore"] });
    let finished = false, text = "", last = "", final = "";
    const messages = new Map<string, { text: string; phase?: string }>();
    const lines = createInterface({ input: child.stdout });
    const finish = (error?: Error) => {
      if (finished) return;
      finished = true;
      lines.close(); child.stdin.end(); child.kill();
      if (error) reject(error); else resolve(provider === "codex" ? text : final || text);
    };
    const send = (value: object) => { if (!finished) child.stdin.write(JSON.stringify(value) + "\n"); };
    const emit = () => {
      const reply = partialBotReply(text);
      if (reply && reply !== last && !signal.aborted) { last = reply; publish(reply); }
    };
    const message = (id: string, phase?: string) => {
      let value = messages.get(id);
      if (!value) { value = { text: "", phase }; messages.set(id, value); }
      if (phase !== undefined) value.phase = phase;
      return value;
    };
    const emitMessage = () => {
      // Creation order, rather than completion order, identifies the latest
      // answer. Late deltas/completions from earlier items cannot replace it.
      const latest = [...messages.values()].reverse().find(value => value.phase !== "commentary");
      text = latest?.text ?? "";
      emit();
    };
    child.on("error", error => finish(error));
    child.stdin.on("error", error => finish(error));
    child.on("close", () => { if (!finished) finish(new Error("Bot stream ended before completion")); });
    lines.on("line", line => {
      if (finished) return;
      try {
        const event = JSON.parse(line);
        if (provider === "codex") {
          if (event.error) return finish(new Error("Bot stream request failed"));
          if (event.id === 1) {
            send({ method: "initialized", params: {} });
            send({ id: 2, method: "thread/start", params: { model, cwd, ephemeral: true,
              approvalPolicy: "never", sandbox: "read-only", config: { "mcp_servers": {}, "web_search": "disabled" } } });
          } else if (event.id === 2) {
            send({ id: 3, method: "turn/start", params: { threadId: event.result.thread.id,
              input: [{ type: "text", text: prompt, text_elements: [] }], outputSchema: schema } });
          } else if (event.method === "item/started" && event.params.item.type === "agentMessage") {
            const item = event.params.item;
            message(item.id ?? "", item.phase).text = item.text ?? "";
            emitMessage();
          } else if (event.method === "item/agentMessage/delta") {
            message(event.params.itemId ?? "", event.params.phase).text += event.params.delta;
            emitMessage();
          }
          else if (event.method === "item/completed" && event.params.item.type === "agentMessage") {
            const item = event.params.item;
            message(item.id ?? "", item.phase).text = item.text;
            emitMessage();
          } else if (event.method === "turn/completed") {
            finish(event.params.turn.status === "completed" ? undefined : new Error("Bot turn failed"));
          } else if (event.id !== undefined && event.method) {
            send({ id: event.id, error: { code: -32601, message: "Bot tools are unavailable" } });
          }
        } else {
          if (event.type === "stream_event") {
            const delta = event.event?.delta;
            if (event.event?.type === "content_block_start") text = "";
            if (delta?.type === "text_delta") { text += delta.text; emit(); }
            if (delta?.type === "input_json_delta") { text += delta.partial_json; emit(); }
          } else if (event.type === "result") {
            if (event.is_error || !event.structured_output) return finish(new Error("Bot turn failed"));
            final = JSON.stringify(event.structured_output); text = final; emit(); finish();
          }
        }
      } catch (error) { finish(error instanceof Error ? error : new Error("Invalid bot stream")); }
    });
    if (provider === "codex") send({ id: 1, method: "initialize", params: {
      clientInfo: { name: "agent_factory_bot", version: "1.0.0" }, capabilities: { experimentalApi: true } } });
    else child.stdin.end(prompt);
  });
}
