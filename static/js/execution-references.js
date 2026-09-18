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

  // Inspect executable positions only; never evaluate shell text or expand variables.
  function shellCommands(source, depth = 0) {
    if (typeof source !== "string" || depth > 3 || source.includes("<<") || source.includes("`")) return [];
    const commands = [], segments = [[]];
    for (const token of shellTokens(source)) {
      if (token.startsWith("\0")) segments.push([]);
      else segments[segments.length - 1].push(token);
    }
    for (let words of segments) {
      while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ["do", "then", "command", "exec"].includes(words[0]))) words = words.slice(1);
      if (/^(?:.*\/)?env$/.test(words[0] || "")) {
        words = words.slice(1);
        while (words.length && (words[0] === "--" || words[0] === "-i" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]))) words = words.slice(1);
      }
      if (/^(?:.*\/)?(?:bash|sh|zsh)$/.test(words[0] || "") && /^-[a-z]*c[a-z]*$/.test(words[1] || "")) {
        commands.push(...shellCommands(words[2], depth + 1));
      } else if (words.length) commands.push(words);
    }
    return commands;
  }

  function scriptInvocations(command) {
    const invocations = [];
    for (const words of shellCommands(command)) {
      let index = 0;
      if (/^(?:.*\/)?python(?:3(?:\.\d+)?)?$/.test(words[0])) {
        index = 1;
        while (["-u", "-B", "-I", "-E", "-s", "-S", "--"].includes(words[index])) index += 1;
      }
      const script = /(?:^|\/)skills\/(agent|convention|document)\/scripts\/([^/]+\.py)$/.exec(words[index] || "");
      if (!script) continue;
      invocations.push({ skill: script[1], script: script[2], path: words[index], action: words[index + 1] || "", args: words.slice(index + 2) });
    }
    return invocations;
  }

  function managedCommand(command, output, children) {
    const candidates = [];
    for (const invocation of scriptInvocations(command)) {
      const script = /^(exec|loop)\.py$/.exec(invocation.script);
      if (invocation.skill !== "agent" || !script) continue;
      const action = invocation.action;
      if (!(script[1] === "exec" ? ["submit", "send", "status", "result", "updates", "cancel"] : ["start", "status", "reconcile", "recover-receipt", "skip"]).includes(action)) continue;
      const args = invocation.args;
      const options = new Map();
      for (let cursor = 0; cursor < args.length; cursor += 1) {
        const arg = args[cursor];
        if (!arg.startsWith("--")) continue;
        const equal = arg.indexOf("=");
        if (equal >= 0) options.set(arg.slice(0, equal), arg.slice(equal + 1));
        else if (args[cursor + 1] !== undefined && !args[cursor + 1].startsWith("--")) options.set(arg, args[++cursor]);
        else options.set(arg, undefined);
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
      candidates.push({ ...(["direct", "work", "plan", "verification", "plan-work", "work-verification", "plan-work-verification"].includes(taskMode) ? { taskMode } : {}), agentId, role: ["work", "verification"].includes(role) ? role : undefined, runId, observedStatus, action, kind: script[1] });
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  function skillDocuments(command) {
    const documents = new Map();
    for (const words of shellCommands(command)) {
      if (!/^(?:.*\/)?(?:cat|head|tail|sed|awk|less|more)$/.test(words[0])) continue;
      for (const token of words.slice(1)) {
        const match = /(?:^|\/)skills\/(?:\.system\/)?([^/]+)\/(SKILL\.md|(?:references|assets|prompt)\/.+\.md)$/.exec(token);
        if (!match || /[\n\r]/.test(token)) continue;
        const plugin = /(?:^|\/)plugins\/cache\/[^/]+\/([^/]+)\/[^/]+\/skills\//.exec(token);
        documents.set(token, { skill: plugin ? plugin[1] + ":" + match[1] : match[1], document: match[2], path: token });
      }
    }
    return [...documents.values()];
  }

  globalThis.agentFactoryExecutionReferences = Object.freeze({ extract, managedCommand, skillDocuments, scriptInvocations });
})();
