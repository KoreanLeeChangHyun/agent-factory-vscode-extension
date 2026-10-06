(function () {
  "use strict";

  function extract(text, markdown, environment = {}) {
    const unchanged = { text, references: [] };
    if (!markdown || typeof text !== "string" || !text.includes("실행 식별자")) return unchanged;
    const tokens = markdown.parse(text, environment);
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

  // Plugin layout with entrypoints at `<plugin-root>/scripts/`; only known names are recognized.
  const ROOT_SCRIPTS = {
    "exec.py": "agent", "loop.py": "agent", "lessons.py": "document", "catalog_documents.py": "document",
    "export_documents.py": "document", "migrate_document_paths.py": "document",
    "search_documents.py": "document", "sync_documents.py": "document"
  };

  function rootScript(path) {
    const match = /(?:^|\/)scripts\/([^/]+\.py)$/.exec(path);
    // A common filename alone is not evidence of an Agent Factory installation.
    // Relocated installations can still identify themselves through operation JSON.
    const owned = /(?:^|\/)agent-factory\/(?:plugin\/)?scripts\//.test(path)
      || /(?:^|\/)plugins\/cache\/[^/]+\/agent-factory\/[^/]+\/scripts\//.test(path);
    return owned && match && Object.hasOwn(ROOT_SCRIPTS, match[1]) ? [match[0], ROOT_SCRIPTS[match[1]], match[1]] : null;
  }

  function scriptAction(args) {
    let index = 0;
    // Global CLI options may precede the verb (notably lessons.py). Consume
    // only known option arities so option values cannot masquerade as actions.
    while (["--project-root", "--runtime-home", "--project-id", "--documents-root", "--input"].some(option => args[index] === option || args[index]?.startsWith(option + "="))) {
      if (args[index].includes("=")) index += 1;
      else {
        if (!args[index + 1] || args[index + 1].startsWith("-")) return "";
        index += 2;
      }
    }
    return args[index] && !args[index].startsWith("-") ? args[index] : "";
  }

  function scriptTarget(args) {
    for (const option of ["--work-agent", "--agent", "--project-root"]) {
      const index = args.findIndex(arg => arg === option || arg.startsWith(option + "="));
      if (index < 0) continue;
      const value = args[index].includes("=") ? args[index].slice(option.length + 1) : args[index + 1];
      if (value && !value.startsWith("-") && !/[\n\r$`]/.test(value)) return value;
    }
    return "";
  }

  function scriptInvocations(command) {
    const invocations = [];
    for (const words of shellCommands(command)) {
      let index = 0;
      if (/^(?:.*\/)?python(?:3(?:\.\d+)?)?$/.test(words[0])) {
        index = 1;
        while (["-u", "-B", "-I", "-E", "-s", "-S", "--"].includes(words[index])) index += 1;
      }
      const path = words[index] || "";
      const script = /(?:^|\/)skills\/(agent|convention|document)\/scripts\/([^/]+\.py)$/.exec(path)
        || rootScript(path);
      if (!script) continue;
      const args = words.slice(index + 1);
      // Only standalone flags before the option terminator request help; quoted
      // prose and values such as --message=--help are not help options.
      const optionEnd = args.indexOf("--");
      const help = args.slice(0, optionEnd < 0 ? args.length : optionEnd).some(arg => arg === "--help" || arg === "-h");
      invocations.push({ skill: script[1], script: script[2], path, action: scriptAction(args), args, target: scriptTarget(args), ...(help ? { help: true } : {}) });
    }
    return invocations;
  }

  function managedCommand(command, output, children) {
    const candidates = [];
    let invocations = scriptInvocations(command);
    // A batch has no single command/result identity, even if only one member
    // happens to carry an agent ID. Keep every invocation in the generic card.
    if (invocations.length > 1) return undefined;
    const structured = runtimeScripts(output);
    if (structured.length && !invocations.length) {
      const data = JSON.parse(output);
      const run = data.run || data;
      const script = structured[0];
      const agentId = script.script === "loop.py" ? run.workAgentId : run.agentId;
      const runId = script.script === "loop.py" ? run.loopId : run.runId;
      if (typeof agentId === "string" && typeof runId === "string") {
        invocations = [{ ...script, args: [script.script === "loop.py" ? "--work-agent" : "--agent", agentId,
          script.script === "loop.py" ? "--loop-id" : "--run-id", runId] }];
      }
    }
    for (const invocation of invocations) {
      if (invocation.help) continue;
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

  // Runtime JSON and provider lifecycle are evidence; command names only label the
  // activity. Never infer that a child completed because its submit command exited.
  function commandOutcome(event) {
    let data;
    try { data = JSON.parse(event.output); } catch { /* Keep raw/mixed output intact. */ }
    const error = data?.kind === "error" && typeof data.error?.message === "string" ? data.error : undefined;
    if (event.phase === "failed" || (Number.isInteger(event.exitCode) && event.exitCode !== 0) || error) return {
      status: "failed", label: "Failed",
      detail: error ? (typeof error.code === "string" ? error.code + ": " : "") + error.message : undefined
    };
    if (event.phase === "started") return { status: "running", label: "In progress" };
    if (event.phase === "completed") return { status: "completed", label: "Command completed" };
    return { status: "unknown", label: "Status unknown" };
  }

  function runtimeScripts(output) {
    let operation;
    try { operation = JSON.parse(output)?.operation; } catch { return []; }
    const actions = { "exec.py": ["init", "location", "projects", "rebind", "map-path", "doctor", "capabilities", "submit", "send", "status", "result", "cancel", "list", "inbox", "reconcile", "goal"], "loop.py": ["start", "status", "reconcile", "recover-receipt", "skip"] };
    if (operation?.schemaVersion !== 1 || operation.provider !== "agent-factory" ||
        !Object.hasOwn(actions, operation.script) || !actions[operation.script].includes(operation.action)) return [];
    return [{ skill: "agent", script: operation.script, action: operation.action, path: "", args: [] }];
  }

  globalThis.agentFactoryExecutionReferences = Object.freeze({ extract, managedCommand, skillDocuments, scriptInvocations, commandOutcome, runtimeScripts });
})();
