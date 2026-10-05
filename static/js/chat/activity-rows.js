// One timeline action = one row: [status] [kind icon] verb · target ······ result · time.
// Rows stay visible; only the raw command, output, diff or reasoning summary folds behind each row.
(function () {
  "use strict";

  const KINDS = new Set(["read", "search", "list", "run", "test", "git", "edit", "web", "page", "tool", "think", "skill"]);
  const READERS = new Set(["cat", "bat", "less", "more", "nl", "head", "tail"]);
  const SEARCHERS = new Set(["rg", "grep", "egrep", "fgrep", "ag", "ack"]);
  const LISTERS = new Set(["ls", "tree", "find", "fd", "fdfind"]);
  // Options whose next word is a value, not a pattern or path; head/tail use -n/-c for counts.
  const VALUE_OPTIONS = new Set(["-e", "--regexp", "-g", "--glob", "-t", "--type", "-T", "--type-not", "-A", "-B", "-C", "-m", "--max-count",
    "-f", "--file", "--max-depth", "-d", "--context", "--after-context", "--before-context", "--include", "--exclude",
    "--exclude-dir", "--lines", "--bytes", "--sort", "-M", "--max-columns", "--color", "--colors"]);
  const COUNT_OPTIONS = new Set(["-n", "-c"]);
  // Provider tool names known before structured arguments existed in saved history.
  const LEGACY_TOOL_KINDS = { Read: "read", view_file: "read", Grep: "search", grep_search: "search", Glob: "list", LS: "list",
    list_dir: "list", find_by_name: "list", WebSearch: "web", search_web: "web", WebFetch: "page", read_url_content: "page" };

  function shellWords(line) {
    const words = [];
    let word = "", quote = "", started = false;
    for (let index = 0; index < line.length; index++) {
      const character = line[index];
      if (quote) {
        if (character === quote) quote = "";
        else if (character === "\\" && quote === "\"" && index + 1 < line.length) word += line[++index];
        else word += character;
      } else if (character === "'" || character === "\"") {
        quote = character;
        started = true;
      } else if (character === "\\" && index + 1 < line.length) {
        word += line[++index];
        started = true;
      } else if (/\s/.test(character)) {
        if (started || word) words.push(word);
        word = "";
        started = false;
      } else {
        word += character;
        started = true;
      }
    }
    if (started || word) words.push(word);
    return words;
  }

  // First shell segment that does work: leading `cd dir &&`, env assignments and wrappers are skipped.
  function commandSegment(line) {
    let rest = line.trim();
    for (;;) {
      const cd = /^cd\s+(?:"[^"]*"|'[^']*'|[^\s;&|]+)\s*(?:&&|;)\s*/.exec(rest);
      if (!cd) break;
      rest = rest.slice(cd[0].length);
    }
    const end = rest.search(/\s(?:&&|\|\||\||;)\s|\s(?:&&|\|\||\|)$/);
    const segment = end >= 0 ? rest.slice(0, end) : rest;
    const words = shellWords(segment);
    while (words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]) || ["env", "sudo", "command", "time", "nice"].includes(words[0]))) words.shift();
    if (words[0] === "timeout" && words.length > 2) words.splice(0, 2);
    return { display: rest, words };
  }

  function positional(words) {
    const values = [];
    const counts = ["head", "tail"].includes((words[0] || "").split("/").pop());
    for (let index = 1; index < words.length; index++) {
      const word = words[index];
      if (word === "--") { values.push(...words.slice(index + 1)); break; }
      if (word.startsWith("-") && word.length > 1) {
        if (VALUE_OPTIONS.has(word) || (counts && COUNT_OPTIONS.has(word))) index++;
        continue;
      }
      values.push(word);
    }
    return values;
  }

  function isTestCommand(words) {
    const [tool, first, second] = words;
    const name = (tool || "").split("/").pop();
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) return first === "test" || first === "t" || (first === "run" && /^test/.test(second || ""));
    if (["pytest", "jest", "vitest", "mocha", "ava", "tap"].includes(name)) return true;
    if (name === "npx" || name === "bunx") return ["jest", "vitest", "mocha", "playwright"].includes(first) && (first !== "playwright" || second === "test");
    if (/^python[\d.]*$/.test(name)) return first === "-m" && ["pytest", "unittest"].includes(second);
    if (name === "uv" || name === "poetry") return words.includes("pytest");
    if (name === "node") return first === "--test" || /(?:^|\/)tests?\//.test(first || "") || /\.test\.[cm]?js$/.test(first || "");
    if (["go", "cargo", "dotnet", "mvn", "gradle", "make"].includes(name)) return first === "test";
    return false;
  }

  /** Kind and target of a shell command, from its first line. Unknown commands run as written. */
  function classifyCommand(text) {
    const source = String(text || "");
    const lines = source.split("\n");
    const firstLine = lines[0].trim();
    const { display, words } = commandSegment(firstLine);
    const runTarget = display + (lines.length > 1 && lines.slice(1).some(line => line.trim()) ? " …" : "");
    const name = (words[0] || "").split("/").pop();
    const args = positional(words);
    if (/<<-?\s*['"]?\w+/.test(firstLine)) return { kind: "run", target: runTarget };
    if (name === "sed" && words.includes("-n")) {
      // sed's -n takes no value, unlike head's.
      const values = words.slice(1).filter(word => !word.startsWith("-"));
      const range = /^(\d+)(?:,(\d+))?p$/.exec(values[0] || "");
      const files = values.slice(1);
      if (range && files.length) {
        return { kind: "read", target: files.join(", "), lineStart: Number(range[1]), lineEnd: Number(range[2] || range[1]) };
      }
    }
    if (READERS.has(name) && args.length) {
      const result = { kind: "read", target: args.join(", ") };
      if (name === "head") {
        const count = words.find((word, index) => index > 0 && (/^-\d+$/.test(word) || (words[index - 1] === "-n" && /^\d+$/.test(word))));
        if (count) Object.assign(result, { lineStart: 1, lineEnd: Number(count.replace("-", "")) });
      }
      return result;
    }
    if (name === "rg" && words.includes("--files")) return { kind: "list", target: args.join(", ") || "." };
    if (SEARCHERS.has(name) || (name === "git" && words[1] === "grep")) {
      const values = name === "git" ? positional(words.slice(1)) : args;
      const explicit = words.indexOf("-e");
      const pattern = explicit > 0 ? words[explicit + 1] : values[0];
      const paths = explicit > 0 ? values : values.slice(1);
      if (pattern !== undefined) return { kind: "search", target: pattern, ...(paths.length ? { scope: paths.join(", ") } : {}) };
    }
    if (LISTERS.has(name)) {
      if (name === "find") {
        const named = words.findIndex(word => ["-name", "-iname", "-path", "-ipath"].includes(word));
        const firstOption = words.findIndex((word, index) => index > 0 && word.startsWith("-"));
        const roots = words.slice(1, firstOption > 0 ? firstOption : words.length);
        if (named > 0 && words[named + 1]) return { kind: "list", target: words[named + 1], ...(roots.length ? { scope: roots.join(", ") } : {}) };
        return { kind: "list", target: roots.join(", ") || "." };
      }
      return { kind: "list", target: args.join(", ") || "." };
    }
    if (name === "git") return { kind: "git", target: runTarget };
    if (isTestCommand(words)) return { kind: "test", target: runTarget };
    return { kind: "run", target: runTarget };
  }

  /** Per-file sections of a git diff, so each changed file gets its own row. */
  function splitDiff(diff) {
    const files = [];
    let current;
    for (const line of String(diff || "").split("\n")) {
      if (line.startsWith("diff --git ")) {
        const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
        current = { path: match ? match[2] : line.slice(11), additions: 0, deletions: 0, lines: [line] };
        files.push(current);
        continue;
      }
      if (!current) continue;
      current.lines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
    }
    return files.map(file => ({ path: file.path, additions: file.additions, deletions: file.deletions, diff: file.lines.join("\n") }));
  }

  /** Host plus the first and last path segments of a URL. */
  function pageTarget(value) {
    try {
      const url = new URL(String(value));
      const parts = url.pathname.split("/").filter(Boolean);
      const path = parts.length > 3 ? "/" + parts[0] + "/…/" + parts.slice(-2).join("/") : url.pathname === "/" ? "" : url.pathname;
      return url.host + path;
    } catch {
      return String(value || "");
    }
  }

  function stripAnsi(text) {
    return String(text || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  }

  function meaningfulLines(text) {
    return stripAnsi(text).split("\n").map(line => line.trim()).filter(Boolean);
  }

  /** Prefer diagnostics over file contents printed after a command failed. */
  function errorLine(event) {
    const reported = meaningfulLines(event.error).filter(line => !/^Exit code \d+$/.test(line));
    if (reported.length) return reported[0];
    const outcome = globalThis.agentFactoryExecutionReferences?.commandOutcome?.(event);
    if (outcome?.detail) return outcome.detail;
    const output = meaningfulLines(event.output);
    // Mixed output can contain a shell error followed by a successfully read JSON
    // file. Its closing brace (or a property) is not an explanation of the failure.
    const isContent = line => /[\p{L}\p{N}]/u.test(line) && !/^["'].*["']\s*:/.test(line);
    const diagnostic = output.filter(line => isContent(line) && /(?:\b[\w.]*Error\s*:|\b(?:error|exception|fatal|failed|failure)\b|\b(?:no such file or directory|permission denied|command not found|cannot (?:open|access))\b)/i.test(line));
    if (diagnostic.length) return diagnostic[diagnostic.length - 1];
    const last = output[output.length - 1];
    return last && isContent(last) ? last : "";
  }

  function outputResult(kind, event) {
    if (event.phase === "started" || typeof event.output !== "string") return undefined;
    const lines = meaningfulLines(event.output);
    if (kind === "search") {
      const found = /^Found (\d+) (file|files|line|lines|match|matches|occurrence|occurrences)\b/i.exec(lines[0] || "");
      if (found) return { key: /^file/i.test(found[2]) ? "diff.files" : "activity.result.matches", values: [Number(found[1])] };
      if (lines.length && lines.every(line => /^(?:[^\s:][^:]*:)?\d+[:-]/.test(line))) return { key: "activity.result.matches", values: [lines.length] };
    }
    if (kind === "list") {
      if (/^No (files|matches) found/i.test(lines[0] || "")) return { key: "activity.result.items", values: [0] };
      return { key: "activity.result.items", values: [lines.filter(line => !/^total \d+$/.test(line)).length] };
    }
    if (kind === "read") return lines.length ? { key: "activity.result.lines", values: [stripAnsi(event.output).replace(/\n$/, "").split("\n").length] } : undefined;
    return lines.length ? { key: "activity.result.output", values: [lines.length] } : undefined;
  }

  function webTitles(key) {
    const message = globalThis.AgentFactoryI18n?.messages?.[key];
    return message ? Object.values(message) : [];
  }

  /** Display model for one activity event: one row, or one row per changed file. */
  function describe(event) {
    const base = { phase: ["started", "completed", "failed"].includes(event.phase) ? event.phase : "started" };
    const provided = KINDS.has(event.kind) ? event.kind : undefined;
    const lines = Number.isInteger(event.lineStart) && event.lineStart > 0
      ? { lineStart: event.lineStart, lineEnd: Number.isInteger(event.lineEnd) && event.lineEnd >= event.lineStart ? event.lineEnd : undefined } : {};
    if (event.category === "file") {
      const files = base.phase === "started" ? [] : splitDiff(event.diff);
      if (!files.length) return [{ ...base, key: "0", kind: "edit", target: event.text || "", path: true, detail: event.diff ? "diff" : "text", diff: event.diff }];
      return files.map((file, index) => ({ ...base, key: String(index), kind: "edit", target: file.path, path: true, detail: "diff",
        diff: file.diff, stats: { additions: file.additions, deletions: file.deletions } }));
    }
    if (provided === "think") return [{ ...base, key: "0", kind: "think", target: "", detail: event.summary ? "summary" : undefined }];
    if (event.category === "command") {
      const skills = globalThis.agentFactoryExecutionReferences?.skillDocuments?.(event.text) || [];
      if (skills.length) {
        return [{ ...base, key: "0", kind: "skill", target: skills.map(item => item.skill).join(", "), detail: "command",
          result: { text: [...new Set(skills.map(item => item.document))].join(", ") } }];
      }
      const classified = classifyCommand(event.text);
      const kind = provided || classified.kind;
      const sameAction = classified.kind === kind;
      const raw = event.target || classified.target;
      const target = kind === "search" ? "\"" + raw + "\"" : raw;
      const range = lines.lineStart ? lines : sameAction && classified.lineStart ? { lineStart: classified.lineStart, lineEnd: classified.lineEnd } : {};
      const scope = event.scope || (sameAction ? classified.scope : undefined);
      const exit = Number.isInteger(event.exitCode) && event.exitCode !== 0 ? { key: "activity.result.exit", values: [event.exitCode] } : undefined;
      const result = range.lineStart
        ? range.lineEnd && range.lineEnd !== range.lineStart ? { key: "activity.result.lines.range", values: [range.lineStart, range.lineEnd] }
          : { key: "activity.result.lines.from", values: [range.lineStart] }
        : outputResult(kind, event);
      return [{ ...base, key: "0", kind, target, scope, path: ["read", "list"].includes(kind) && !scope, detail: "command",
        result: exit && result ? [exit, result] : exit || result }];
    }
    // Tools: web search, page, provider read/search/list tools and connected tools.
    const legacyTool = /^([A-Za-z0-9_.-]+)\/([^\s/]+)$/.exec(event.text || "");
    const isWebSearch = webTitles("ui.web.search").includes(event.title);
    const isPage = webTitles("ui.web.page.open").includes(event.title) || (!provided && /^https?:\/\/\S+$/.test(event.text || ""));
    const kind = provided || (isPage ? "page" : isWebSearch ? "web" : legacyTool && LEGACY_TOOL_KINDS[legacyTool[2]]) || "tool";
    if (kind === "web" || kind === "page") {
      const raw = event.target || event.text || "";
      return [{ ...base, key: "0", kind, target: kind === "page" ? pageTarget(raw) : raw.split("\n").join(" · "), argument: event.scope, detail: "text" }];
    }
    if (kind === "tool") {
      const identity = legacyTool ? legacyTool[1] + " · " + legacyTool[2] : event.text || "";
      return [{ ...base, key: "0", kind, target: identity, argument: event.scope, detail: "text" }];
    }
    // A provider read/search/list tool: its arguments name the target; legacy history only had the tool name.
    const range = lines.lineStart ? lines : {};
    const result = range.lineStart
      ? range.lineEnd && range.lineEnd !== range.lineStart ? { key: "activity.result.lines.range", values: [range.lineStart, range.lineEnd] }
        : { key: "activity.result.lines.from", values: [range.lineStart] }
      : outputResult(kind, event);
    const target = event.target ? kind === "search" ? "\"" + event.target + "\"" : event.target : legacyTool ? legacyTool[2] : event.text || "";
    return [{ ...base, key: "0", kind, target, scope: event.scope, path: Boolean(event.target) && kind !== "search" && !event.scope,
      detail: "text", result }];
  }

  /** The separate paths of a path or scope list; commands join several files with ", ". */
  function splitPaths(value) {
    return String(value || "").split(", ").filter(Boolean);
  }

  function pathSegments(path) {
    return String(path).replace(/\/+$/, "").split("/").filter(Boolean);
  }

  /**
   * Short label for each path: its last segment, plus as many parent directories as needed
   * to tell it apart from other paths in the same group that end the same way.
   */
  function shortPaths(paths, peers = paths) {
    const others = [...new Set(peers.map(String))];
    return paths.map(function (path) {
      const segments = pathSegments(path);
      if (!segments.length) return String(path);
      let count = 1;
      for (const other of others) {
        if (other === String(path)) continue;
        const theirs = pathSegments(other);
        let shared = 0;
        while (shared < segments.length && shared < theirs.length && segments[segments.length - 1 - shared] === theirs[theirs.length - 1 - shared]) shared++;
        count = Math.max(count, shared + 1);
      }
      return segments.slice(-Math.min(count, segments.length)).join("/");
    });
  }

  globalThis.agentFactoryActivityRows = Object.freeze({ shellWords, classifyCommand, splitDiff, pageTarget, errorLine, describe, splitPaths, shortPaths });
})();

globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.activityRows = function (host) {
  "use strict";

  const { t, timeline, chatTerminal, chatSyntax, chatMarkdown } = host;
  const model = globalThis.agentFactoryActivityRows;
  const SVG = "http://www.w3.org/2000/svg";
  // Monochrome 16px glyphs; status is carried by text and a small leading mark, never by borders.
  const ICONS = {
    read: "M4 2h6l3 3v9H4z M10 2v3h3 M6 8h5 M6 11h5",
    search: "M7 3a4 4 0 1 1 0 8a4 4 0 1 1 0-8z M10 10l4 4",
    list: "M2 4h5l1 2h6v7H2z",
    skill: "M3 3h4a2 2 0 0 1 1 1v10a2 2 0 0 0-1-1H3z M13 3H9a2 2 0 0 0-1 1v10a2 2 0 0 1 1-1h4z",
    git: "M5 3v10 M11 6a2 2 0 1 0 0-.1z M5 13a2 2 0 1 0 0-.1z M11 8c0 3-6 2-6 4",
    web: "M8 2a6 6 0 1 1 0 12a6 6 0 1 1 0-12z M2 8h12 M8 2c3 3 3 9 0 12 M8 2c-3 3-3 9 0 12",
    page: "M7 9l2-2 M6 6l2-2a2.5 2.5 0 0 1 4 4l-2 2 M10 10l-2 2a2.5 2.5 0 0 1-4-4l2-2",
    edit: "M3 13l1-3 7-7 2 2-7 7z M9 5l2 2",
    run: "M3 4l4 4-4 4 M8 12h5",
    test: "M6 2h4 M7 2v4l-4 7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l-4-7V2",
    tool: "M6 2v4 M10 2v4 M4 6h8v2a4 4 0 0 1-8 0z M8 12v2",
    think: "M8 2a4 4 0 0 1 3 7v2H5V9a4 4 0 0 1 3-7z M6 14h4"
  };
  const builders = new WeakMap();
  const tooltips = new WeakMap();
  let tooltip;
  let tooltipTimer;
  let elapsedTimer;
  const verbWidths = new Map();
  const listWidths = new WeakMap();
  let measure;

  function icon(kind) {
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", "0 0 16 16");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("focusable", "false");
    svg.setAttribute("class", "act-icon");
    const path = document.createElementNS(SVG, "path");
    path.setAttribute("d", ICONS[kind] || ICONS.tool);
    svg.append(path);
    return svg;
  }

  function span(className, text) {
    const node = document.createElement("span");
    node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function duration(ms) {
    if (!(ms >= 0)) return "";
    if (ms < 1000) return t("activity.duration.ms", Math.round(ms));
    const seconds = ms / 1000;
    if (seconds < 10) return t("duration.seconds", (Math.round(seconds * 10) / 10).toFixed(1));
    if (seconds < 60) return t("duration.seconds", Math.round(seconds));
    const whole = Math.round(seconds);
    if (whole < 3600) return t("duration.minutes", Math.floor(whole / 60), whole % 60);
    return t("duration.hours", Math.floor(whole / 3600), Math.floor(whole % 3600 / 60), whole % 60);
  }

  function elapsedSeconds(startedAt) {
    return t("duration.seconds", Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
  }

  // Provider durations are exact; receipt timestamps only resolve whole seconds of polling.
  function eventDuration(event) {
    if (Number.isFinite(event.durationMs) && event.durationMs >= 0) return event.durationMs;
    if (Number.isFinite(event.startedAt) && Number.isFinite(event.completedAt) && event.completedAt - event.startedAt >= 1000) {
      return event.completedAt - event.startedAt;
    }
    return undefined;
  }

  function verb(row) {
    return t("activity.verb." + row.kind + "." + row.phase);
  }

  function resultText(result, compact = false) {
    const parts = Array.isArray(result) ? result : result ? [result] : [];
    return parts.map(part => part.key ? t(compact && part.key === "activity.result.output" ? "activity.result.lines" : compact && part.key === "activity.result.exit" ? "activity.result.exit.compact" : part.key, ...part.values) : part.text).filter(Boolean);
  }

  /** Full paths a row names: its files, or a search's scope. Shown at the top of the opened detail. */
  function fullPaths(row) {
    return [...(row.path ? model.splitPaths(row.target) : []), ...model.splitPaths(row.scope)];
  }

  // Paths show only their names; a timeline group adds parent directories where names collide.
  function pathLabel(paths, peers) {
    return model.shortPaths(paths, peers).join(", ");
  }

  function appendTarget(button, row) {
    const target = span("act-target");
    if (row.path) {
      const paths = model.splitPaths(row.target);
      const name = span("act-target-tail", pathLabel(paths));
      name.dataset.paths = JSON.stringify(paths);
      target.append(name);
    } else {
      target.append(span("act-target-head", row.target || ""));
    }
    if (row.scope) {
      const scopes = model.splitPaths(row.scope);
      const scope = span("act-scope", " " + t("activity.target.in", "", pathLabel(scopes)).trim());
      scope.dataset.scopes = JSON.stringify(scopes);
      target.append(scope);
    }
    if (row.argument) target.append(span("act-scope", " " + row.argument));
    button.append(target);
  }

  function tooltipText(event, row) {
    const lines = [];
    // Completion-only events still know their start when the provider reported a duration.
    const startedAt = Number.isFinite(event.startedAt) ? event.startedAt
      : Number.isFinite(event.completedAt) && Number.isFinite(event.durationMs) ? event.completedAt - event.durationMs : undefined;
    if (startedAt !== undefined) lines.push(t("activity.tooltip.started", new Date(startedAt).toLocaleTimeString()));
    const took = eventDuration(event);
    if (took !== undefined && row.phase !== "started") lines.push(t("activity.tooltip.duration", duration(took)));
    if (Number.isInteger(event.exitCode) && event.exitCode !== 0) lines.push(t("activity.tooltip.exit", event.exitCode));
    const paths = fullPaths(row);
    lines.push(...paths);
    const raw = row.kind === "edit" ? "" : row.kind === "think" ? "" : event.text;
    if (raw && !paths.includes(raw)) lines.push(raw.length > 2000 ? raw.slice(0, 2000) + "…" : raw);
    return lines.join("\n");
  }

  function renderDetail(detail, event, row) {
    const paths = fullPaths(row);
    if (paths.length) {
      const list = document.createElement("div");
      list.className = "act-paths";
      for (const path of paths) {
        const line = document.createElement("div");
        line.textContent = path;
        list.append(line);
      }
      detail.append(list);
    }
    if (row.detail === "command") {
      chatTerminal.renderTerminalCommand(detail, event.text, event.phase);
      chatTerminal.renderCommandOutput(detail, event.output, false);
    } else if (row.detail === "diff") {
      chatSyntax.renderGitDiff(detail, row.diff, row.target, event.phase);
    } else if (row.detail === "summary") {
      const summary = document.createElement("div");
      summary.className = "act-summary";
      chatMarkdown.renderAssistantMarkdown(summary, event.summary);
      detail.append(summary);
    } else {
      const text = document.createElement("pre");
      text.className = "act-raw";
      text.textContent = [event.text, event.scope].filter(Boolean).join("\n");
      detail.append(text);
      if (typeof event.output === "string" && event.output) chatTerminal.renderCommandOutput(detail, event.output, false);
    }
  }

  function setExpanded(wrap, expanded) {
    const button = wrap.querySelector(":scope > .act-row");
    const detail = wrap.querySelector(":scope > .act-detail");
    if (!button || !detail || button.getAttribute("aria-expanded") === null) return;
    if (expanded && !detail.childElementCount) builders.get(detail)?.();
    detail.hidden = !expanded;
    button.setAttribute("aria-expanded", String(expanded));
  }

  function renderRow(list, event, row) {
    const wrap = document.createElement("div");
    wrap.className = "act-row-wrap";
    wrap.setAttribute("role", "listitem");
    wrap.dataset.kind = row.kind;
    wrap.dataset.phase = row.phase;
    wrap.dataset.rowKey = row.key;
    const expandable = Boolean(row.detail);
    const button = document.createElement(expandable ? "button" : "div");
    button.className = "act-row";
    if (expandable) {
      button.type = "button";
      button.setAttribute("aria-expanded", "false");
    } else {
      button.tabIndex = 0;
    }
    const running = row.phase === "started" && host.isRunning();
    const mark = span("act-mark", row.phase === "failed" ? "!" : "");
    mark.setAttribute("aria-hidden", "true");
    if (running) mark.classList.add("is-running");
    button.append(mark, icon(row.kind), span("act-verb", verb(row)));
    if (row.target || row.scope || row.argument) appendTarget(button, row);
    const meta = span("act-meta");
    const pieces = resultText(row.result);
    if (row.stats) {
      const stats = span("act-stats");
      stats.append(span("git-diff-count-addition", "+" + row.stats.additions), " ", span("git-diff-count-deletion", "−" + row.stats.deletions));
      meta.append(stats);
    }
    const compactPieces = resultText(row.result, true);
    for (const [index, piece] of pieces.entries()) {
      if (meta.childNodes.length) meta.append(" · ");
      if (compactPieces[index] !== piece) {
        meta.append(span("act-result-full", piece), span("act-result-compact", compactPieces[index]));
      } else meta.append(piece);
    }
    const took = eventDuration(event);
    if (running && Number.isFinite(event.startedAt)) {
      if (meta.childNodes.length) meta.append(" · ");
      const elapsed = span("act-elapsed", elapsedSeconds(event.startedAt));
      elapsed.dataset.startedAt = String(event.startedAt);
      meta.append(elapsed);
    } else if (took !== undefined && row.phase !== "started") {
      if (meta.childNodes.length) meta.append(" · ");
      meta.append(duration(took));
    }
    if (meta.childNodes.length) button.append(meta);
    const label = [verb(row), row.target, row.scope ? t("activity.target.in", "", row.scope).trim() : "", row.argument,
      row.stats ? "+" + row.stats.additions + " −" + row.stats.deletions : "", ...pieces,
      took !== undefined && row.phase !== "started" ? duration(took) : ""].filter(Boolean).join(", ");
    button.setAttribute("aria-label", label);
    tooltips.set(button, tooltipText(event, row));
    wrap.append(button);
    if (row.phase === "failed") {
      const message = model.errorLine(event);
      if (message) wrap.append(span("act-error", message));
    }
    if (expandable) {
      const detail = document.createElement("div");
      detail.className = "act-detail";
      detail.hidden = true;
      builders.set(detail, function () { renderDetail(detail, event, row); });
      button.addEventListener("click", function () {
        setExpanded(wrap, button.getAttribute("aria-expanded") !== "true");
      });
      wrap.append(detail);
    }
    list.append(wrap);
    if (running) ensureElapsedTimer();
  }

  // Consecutive row messages share one verb column sized to their longest verb, so targets start
  // together. Verb widths come from a canvas, not layout; only the group around a change is updated.
  function verbWidth(text) {
    let width = verbWidths.get(text);
    if (width !== undefined) return width;
    if (measure === undefined) {
      const style = getComputedStyle(timeline);
      const context = document.createElement("canvas").getContext("2d");
      if (context) context.font = [style.fontStyle, style.fontWeight, style.fontSize, style.fontFamily].join(" ");
      measure = context ? { context, size: parseFloat(style.fontSize) } : null;
    }
    width = measure ? Math.ceil(measure.context.measureText(text).width / measure.size * 100) / 100 : 0;
    verbWidths.set(text, width);
    return width;
  }

  function isRowMessage(node) {
    return Boolean(node?.classList?.contains("message-activity-row"));
  }

  // Same names within one group of consecutive row messages get the parent directories that tell them apart.
  function relabelPaths(group) {
    const parse = (node, key) => JSON.parse(node.dataset[key]);
    const names = group.flatMap(item => Array.from(item.querySelectorAll(".act-target-tail[data-paths]")));
    const scopes = group.flatMap(item => Array.from(item.querySelectorAll(".act-scope[data-scopes]")));
    const peers = [...names.flatMap(node => parse(node, "paths")), ...scopes.flatMap(node => parse(node, "scopes"))];
    for (const node of names) {
      const text = pathLabel(parse(node, "paths"), peers);
      if (node.textContent !== text) node.textContent = text;
    }
    for (const node of scopes) {
      const text = " " + t("activity.target.in", "", pathLabel(parse(node, "scopes"), peers)).trim();
      if (node.textContent !== text) node.textContent = text;
    }
  }

  function alignVerbColumns(records) {
    const done = new Set();
    for (const record of records) {
      for (const node of [...record.addedNodes, record.previousSibling, record.nextSibling]) {
        if (!isRowMessage(node) || done.has(node) || !node.isConnected) continue;
        let first = node;
        while (isRowMessage(first.previousElementSibling)) first = first.previousElementSibling;
        const group = [];
        for (let item = first; isRowMessage(item); item = item.nextElementSibling) {
          group.push(item);
          done.add(item);
        }
        relabelPaths(group);
        const width = Math.max(...group.map(item => listWidths.get(item.querySelector(":scope > .act-list")) || 0)) + "em";
        for (const item of group) {
          if (item.style.getPropertyValue("--act-verb-width") !== width) item.style.setProperty("--act-verb-width", width);
        }
      }
    }
  }
  // Message insertion, replacement and removal are synchronous; the observer runs before paint.
  new MutationObserver(alignVerbColumns).observe(timeline, { childList: true });

  /** Renders an activity event as one or more rows in its message content. */
  function render(content, event) {
    content.classList.add("act-list");
    content.setAttribute("role", "list");
    let widest = 0;
    for (const row of model.describe(event)) {
      renderRow(content, event, row);
      widest = Math.max(widest, verbWidth(verb(row)));
    }
    listWidths.set(content, widest);
  }

  function expandedKeys(element) {
    return Array.from(element.querySelectorAll(".act-row-wrap")).filter(function (wrap) {
      return wrap.querySelector(":scope > .act-row")?.getAttribute("aria-expanded") === "true";
    }).map(wrap => wrap.dataset.rowKey);
  }

  function restoreExpanded(element, keys) {
    if (!Array.isArray(keys) || !keys.length) return;
    for (const wrap of element.querySelectorAll(".act-row-wrap")) {
      if (keys.includes(wrap.dataset.rowKey)) setExpanded(wrap, true);
    }
  }

  // Running rows tick their elapsed seconds in place; nothing else re-renders.
  function ensureElapsedTimer() {
    if (elapsedTimer) return;
    elapsedTimer = setInterval(function () {
      if (document.hidden) return;
      const items = timeline.querySelectorAll(".act-elapsed[data-started-at]");
      if (!items.length) {
        clearInterval(elapsedTimer);
        elapsedTimer = undefined;
        return;
      }
      for (const item of items) {
        const text = elapsedSeconds(Number(item.dataset.startedAt));
        if (item.textContent !== text) item.textContent = text;
      }
    }, 1000);
  }

  function hideTooltip() {
    clearTimeout(tooltipTimer);
    tooltipTimer = undefined;
    if (!tooltip || tooltip.hidden) return;
    tooltip.hidden = true;
    document.querySelector("[aria-describedby='activity-tooltip']")?.removeAttribute("aria-describedby");
  }

  function showTooltip(row) {
    const text = tooltips.get(row);
    if (!text || !row.isConnected) return;
    if (!tooltip) {
      tooltip = document.createElement("div");
      tooltip.id = "activity-tooltip";
      tooltip.className = "act-tooltip";
      tooltip.setAttribute("role", "tooltip");
      tooltip.hidden = true;
      document.body.append(tooltip);
    }
    tooltip.textContent = text;
    tooltip.hidden = false;
    row.setAttribute("aria-describedby", "activity-tooltip");
    // Below the row when it fits, otherwise above; the row itself never grows.
    const rect = row.getBoundingClientRect();
    const box = tooltip.getBoundingClientRect();
    const left = Math.max(4, Math.min(rect.left + 24, window.innerWidth - box.width - 4));
    const below = rect.bottom + 4;
    tooltip.style.left = left + "px";
    tooltip.style.top = (below + box.height <= window.innerHeight ? below : Math.max(4, rect.top - box.height - 4)) + "px";
  }

  timeline.addEventListener("pointerover", function (event) {
    const row = event.target.closest?.(".act-row");
    if (!row || row.contains(event.relatedTarget)) return;
    hideTooltip();
    tooltipTimer = setTimeout(function () { showTooltip(row); }, 500);
  });
  timeline.addEventListener("pointerout", function (event) {
    const row = event.target.closest?.(".act-row");
    if (row && !row.contains(event.relatedTarget)) hideTooltip();
  });
  timeline.addEventListener("focusin", function (event) {
    const row = event.target.closest?.(".act-row");
    hideTooltip();
    if (row && row.matches(":focus-visible")) showTooltip(row);
  });
  timeline.addEventListener("focusout", hideTooltip);
  timeline.addEventListener("scroll", hideTooltip, { passive: true });
  // Arrow keys move between action rows; Escape closes the tooltip.
  timeline.addEventListener("keydown", function (event) {
    const row = event.target.closest?.(".act-row");
    if (!row) return;
    if (event.key === "Escape") { hideTooltip(); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
    const rows = Array.from(timeline.querySelectorAll(".act-row"));
    const index = rows.indexOf(row);
    const next = event.key === "Home" ? rows[0] : event.key === "End" ? rows[rows.length - 1] : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.scrollIntoView({ block: "nearest" });
  });

  return { render, expandedKeys, restoreExpanded };
};
