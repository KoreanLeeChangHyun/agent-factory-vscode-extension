(function () {
  "use strict";

  function extract(text, markdown) {
    const unchanged = { text, references: [] };
    if (!markdown || typeof text !== "string" || !text.includes("실행 식별자")) return unchanged;
    const tokens = markdown.parse(text, {});
    const lines = text.split("\n");
    const candidates = [];
    for (let index = 0; index < tokens.length - 3; index += 1) {
      const heading = tokens[index];
      if (heading.type !== "paragraph_open" || heading.level !== 0 || !heading.map) continue;
      const inline = tokens[index + 1];
      if (inline.type !== "inline" || !/^실행 식별자[:：]$/.test(inline.content)) continue;
      const list = tokens[index + 3];
      if (tokens[index + 2].type !== "paragraph_close" || list.type !== "bullet_list_open" || list.level !== 0 || !list.map) continue;
      if (lines.slice(heading.map[1], list.map[0]).some(line => line.trim())) continue;
      const references = [];
      const seen = new Set();
      const rows = lines.slice(list.map[0], list.map[1]);
      while (rows.length && !rows[rows.length - 1].trim()) rows.pop();
      for (const row of rows) {
        const match = /^[-*+] (Work Agent|Work Run|Work Session|예약된 Verification Agent|Loop)[:：]\s+(?:`([A-Za-z0-9][A-Za-z0-9._-]{0,127})`|([A-Za-z0-9][A-Za-z0-9._-]{0,127}))\s*$/.exec(row);
        if (!match || seen.has(match[1])) return unchanged;
        seen.add(match[1]);
        references.push({ label: match[1], id: match[2] || match[3] });
      }
      if (!references.length) return unchanged;
      candidates.push({ start: heading.map[0], end: list.map[1], references });
    }
    if (candidates.length !== 1) return unchanged;
    const block = candidates[0];
    const before = lines.slice(0, block.start).join("\n");
    const after = lines.slice(block.end).join("\n");
    return {
      text: [before, after].filter(Boolean).join("\n"),
      before,
      after,
      references: block.references
    };
  }

  // Tokenize only enough shell syntax to identify real invocations. Quoted prose
  // stays one token, so examples inside echo/message arguments are never commands.
  function shellTokens(source) {
    const tokens = [];
    let value = "", active = false, quote;
    function flush() { if (active) tokens.push(value); value = ""; active = false; }
    for (let index = 0; index < source.length; index += 1) {
      const char = source[index];
      if (quote) {
        if (char === quote) quote = undefined;
        else if (char === "\\" && quote === '"' && index + 1 < source.length) value += source[++index];
        else value += char;
      } else if (char === "'" || char === '"') { quote = char; active = true; }
      else if (char === "\\" && index + 1 < source.length) { value += source[++index]; active = true; }
      else if (char === "#" && !active) { while (index < source.length && source[index] !== "\n") index += 1; flush(); tokens.push("\0;"); }
      else if (/\s/.test(char)) { flush(); if (char === "\n") tokens.push("\0;"); }
      else if (";|&()".includes(char)) { flush(); tokens.push("\0" + char); }
      else { value += char; active = true; }
    }
    if (quote) return [];
    flush();
    return tokens;
  }

  function managedCommand(command, output, children) {
    if (typeof command !== "string" || /(^|[^<])<<[^<]/.test(command) || command.includes("`")) return undefined;
    const tokens = shellTokens(command);
    const candidates = [];
    for (let index = 0; index < tokens.length - 2; index += 1) {
      if (!/^(?:[^\s]*\/)?python(?:3(?:\.\d+)?)?$/.test(tokens[index])) continue;
      if (index && !["\0;", "\0|", "\0&", "\0(", "do", "then"].includes(tokens[index - 1])) continue;
      const script = /(?:^|\/)skills\/agent\/scripts\/(exec|loop)\.py$/.exec(tokens[index + 1]);
      if (!script) continue;
      const action = tokens[index + 2];
      if (!(script[1] === "exec" ? ["submit", "send", "status", "result", "updates", "cancel"] : ["start", "status", "reconcile", "recover-receipt", "skip"]).includes(action)) continue;
      const args = [];
      for (let cursor = index + 3; cursor < tokens.length && !["\0;", "\0|", "\0&", "\0(", "\0)"].includes(tokens[cursor]); cursor += 1) args.push(tokens[cursor]);
      const options = new Map();
      for (let cursor = 0; cursor < args.length; cursor += 1) {
        const arg = args[cursor];
        if (!arg.startsWith("--")) continue;
        const equal = arg.indexOf("=");
        if (equal >= 0) options.set(arg.slice(0, equal), arg.slice(equal + 1));
        else options.set(arg, args[++cursor]);
      }
      const option = name => options.get(name);
      const agentId = option(script[1] === "loop" ? "--work-agent" : "--agent");
      if (!agentId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(agentId)) continue;
      const child = (children || []).find(agent => agent.agentId === agentId);
      const role = script[1] === "loop" ? "work" : option("--role") || child?.role;
      let runId = option(script[1] === "loop" ? "--loop-id" : "--run-id");
      let observedStatus;
      let taskMode = option("--task-mode");
      try {
        const data = JSON.parse(output);
        const run = data.run || data;
        const outputId = script[1] === "loop" ? run.loopId : run.runId;
        if ((!data.agentId || data.agentId === agentId) && (!run.agentId || run.agentId === agentId) && (!run.workAgentId || run.workAgentId === agentId) && (!runId || outputId === runId)) {
          runId = runId || outputId;
          observedStatus = run.status;
          taskMode = run.taskMode || taskMode;
        }
      } catch { /* Command output remains available as raw evidence. */ }
      candidates.push({ ...(["direct", "work", "plan-work", "work-verification", "plan-work-verification"].includes(taskMode) ? { taskMode } : {}), agentId, role: ["work", "verification"].includes(role) ? role : undefined, runId, observedStatus, action, kind: script[1] });
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function skillDocuments(command) {
    if (typeof command !== "string" || command.includes("`") || command.includes("<<")) return [];
    const tokens = shellTokens(command), documents = new Map();
    let reading = false;
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.startsWith("\0")) { reading = false; continue; }
      if (index === 0 || tokens[index - 1].startsWith("\0")) {
        reading = /^(?:.*\/)?(?:cat|head|tail|sed|awk)$/.test(token);
        continue;
      }
      if (!reading) continue;
      const match = /(?:^|\/)skills\/(?:\.system\/)?([^/]+)\/(SKILL\.md|references\/.+\.md)$/.exec(token);
      if (!match) continue;
      const plugin = /(?:^|\/)plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\//.exec(token);
      documents.set(token, { skill: plugin ? plugin[1] + ":" + match[1] : match[1], document: match[2], path: token });
    }
    return [...documents.values()];
  }

  globalThis.agentFactoryExecutionReferences = Object.freeze({ extract, managedCommand, skillDocuments });
})();
