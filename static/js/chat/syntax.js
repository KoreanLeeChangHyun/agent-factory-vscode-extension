globalThis.AgentFactoryChat = globalThis.AgentFactoryChat || {};
globalThis.AgentFactoryChat.syntax = function (host) {
  "use strict";

  const {
    createActivityPhase, t, renderTimeline
  } = host;

  let syntaxRevision = 0;
  let themeUpdate = 0;
  function renderGitDiff(container, diff, fallbackText, phaseValue) {
    container.classList.add("git-diff-content");
    const files = parseGitDiff(diff);
    const additions = files.reduce(function (sum, file) { return sum + file.additions; }, 0);
    const deletions = files.reduce(function (sum, file) { return sum + file.deletions; }, 0);
    const overview = document.createElement("div");
    overview.className = "git-diff-overview";
    overview.append(createActivityPhase(phaseValue));
    const label = document.createElement("span");
    label.append(document.createTextNode(t("ui.edited") + (files.length === 1 ? files[0].path : t("diff.files", files.length || 1)) + " "));
    const stats = document.createElement("span");
    stats.className = "git-diff-stats";
    stats.append("(", createDiffCount("+" + additions, "addition"), " ", createDiffCount("−" + deletions, "deletion"), ")");
    label.append(stats);
    overview.append(label);
    container.append(overview);

    const list = document.createElement("div");
    list.className = "git-diff-files";
    if (files.length === 0) {
      list.textContent = fallbackText;
    } else {
      files.forEach(function (file) {
        const row = document.createElement("div");
        row.className = "git-diff-file";
        const path = document.createElement("span");
        path.textContent = file.path;
        const count = document.createElement("span");
        count.className = "git-diff-file-stats";
        count.append(createDiffCount("+" + file.additions, "addition"), " ", createDiffCount("−" + file.deletions, "deletion"));
        row.append(path, count);
        list.append(row);
      });
    }
    if (files.length !== 1) container.append(list);
    renderInlineDiff(container, diff);

    const details = document.createElement("details");
    details.className = "git-diff-preview";
    details.open = false;
    const summary = document.createElement("summary");
    summary.textContent = t("ui.view.git.diff");
    const pre = document.createElement("pre");
    const code = document.createElement("code");
    diff.split("\n").forEach(function (line) {
      const span = document.createElement("span");
      span.className = gitDiffLineClass(line);
      span.textContent = line || " ";
      code.append(span);
    });
    pre.append(code);
    details.append(summary, pre);
    container.append(details);
    void applyDiffSyntaxHighlighting(code, diff);
  }
  function createDiffCount(text, kind) {
    const count = document.createElement("span");
    count.className = "git-diff-count-" + kind;
    count.textContent = text;
    return count;
  }
  function renderInlineDiff(container, diff) {
    const preview = document.createElement("pre");
    preview.className = "git-diff-inline";
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let shown = 0;
    const multipleFiles = parseGitDiff(diff).length > 1;
    for (const [lineIndex, line] of diff.split("\n").entries()) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
        inHunk = true;
        continue;
      }
      if (line.startsWith("diff --git ")) {
        inHunk = false;
        if (multipleFiles && shown < 12) {
          const file = document.createElement("span");
          file.className = "git-diff-inline-file";
          const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
          file.textContent = match ? match[2] : line.slice(11);
          preview.append(file);
        }
        continue;
      }
      if (!inHunk || !/^[ +\-]/.test(line)) continue;
      const number = line.startsWith("-") ? oldLine : newLine;
      if (!line.startsWith("+")) oldLine++;
      if (!line.startsWith("-")) newLine++;
      if (shown++ >= 12) continue;
      const row = document.createElement("span");
      row.className = "git-diff-line" + (line.startsWith("+") ? " git-diff-addition" : line.startsWith("-") ? " git-diff-deletion" : "");
      const gutter = document.createElement("span");
      gutter.className = "git-diff-line-number";
      gutter.textContent = String(number);
      const sign = document.createElement("span");
      sign.className = "git-diff-sign";
      sign.textContent = line.slice(0, 1);
      const source = document.createElement("span");
      source.className = "git-diff-source";
      source.textContent = line.slice(1);
      row.append(gutter, sign, source);
      source.dataset.diffIndex = String(lineIndex);
      preview.append(row);
    }
    if (shown > 12) {
      const more = document.createElement("span");
      more.className = "git-diff-more";
      more.textContent = t("diff.more", shown - 12);
      preview.append(more);
    }
    if (shown > 0) {
      container.append(preview);
      void applyDiffSyntaxHighlighting(preview, diff, true);
    }
  }
  async function applyDiffSyntaxHighlighting(code, diff, inline) {
    const highlighter = globalThis.agentFactorySyntaxHighlighter;
    if (!highlighter) return;
    const revision = syntaxRevision;
    const elements = inline
      ? new Map(Array.from(code.querySelectorAll("[data-diff-index]")).map(function (element) { return [Number(element.dataset.diffIndex), element]; }))
      : new Map(Array.from(code.children).map(function (element, index) { return [index, element]; }));
    const sections = [];
    let path = "";
    let section;
    diff.split("\n").forEach(function (line, index) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        path = match ? match[2] : "";
        section = undefined;
      } else if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
        section = { path, entries: [] };
        sections.push(section);
      } else if (section && /^[ +\-]/.test(line)) {
        section.entries.push({ index, prefix: line.slice(0, 1), text: line.slice(1) });
      }
    });
    await Promise.all(sections.map(async function (item) {
      const language = highlighter.languageForPath(item.path);
      if (!language || !item.entries.some(function (entry) { return elements.has(entry.index); })) return;
      const lastVisible = inline ? Math.max(...item.entries.filter(function (entry) { return elements.has(entry.index); }).map(function (entry) { return entry.index; })) : Infinity;
      await Promise.all(["old", "new"].map(async function (side) {
        const entries = item.entries.filter(function (entry) {
          return entry.index <= lastVisible && entry.prefix !== (side === "old" ? "+" : "-");
        });
        if (entries.length === 0) return;
        try {
          const highlighted = await highlighter.highlight(entries.map(function (entry) { return entry.text; }).join("\n"), language, currentSyntaxThemeClass() !== "light", isHighContrast());
          if (revision !== syntaxRevision || !code.isConnected) return;
          entries.forEach(function (entry, index) {
            const element = elements.get(entry.index);
            const tokens = highlighted[index];
            if (element && tokens && (side === "new" || entry.prefix === "-")) renderHighlightedTokens(element, tokens, inline ? "" : entry.prefix);
          });
        } catch {
        }
      }));
    }));
  }
  async function applySyntaxHighlighting(element, code, language) {
    const highlighter = globalThis.agentFactorySyntaxHighlighter;
    if (!highlighter) return;
    const revision = syntaxRevision;
    try {
      const highlighted = await highlighter.highlight(
        code,
        language,
        currentSyntaxThemeClass() !== "light",
        isHighContrast()
      );
      if (revision !== syntaxRevision || !element.isConnected || highlighted.length === 0) return;
      const fragment = document.createDocumentFragment();
      highlighted.forEach(function (tokens, index) {
        if (index > 0) fragment.append(document.createTextNode("\n"));
        appendHighlightedTokens(fragment, tokens);
      });
      element.replaceChildren(fragment);
    } catch {
      // The original text is the progressive fallback when highlighting fails.
    }
  }
  function renderHighlightedTokens(element, tokens, prefix) {
    element.replaceChildren(document.createTextNode(prefix));
    appendHighlightedTokens(element, tokens);
  }
  function appendHighlightedTokens(container, tokens) {
    tokens.forEach(function (token) {
      const span = document.createElement("span");
      span.textContent = token.content;
      if (token.color) span.style.color = token.color;
      if (token.fontStyle & 1) span.style.fontStyle = "italic";
      if (token.fontStyle & 2) span.style.fontWeight = "bold";
      if (token.fontStyle & 4) span.style.textDecoration = "underline";
      container.append(span);
    });
  }
  async function updateSyntaxTheme(selection) {
    const update = ++themeUpdate;
    syntaxRevision += 1;
    try {
      if (globalThis.agentFactorySyntaxHighlighter) {
        await globalThis.agentFactorySyntaxHighlighter.configureTheme(selection);
      }
      if (update !== themeUpdate) return;
      if (selection.error) upsertThemeWarning(selection.error);
      else host.state.timeline = host.state.timeline.filter(function (event) { return event.id !== "syntax-theme-warning"; });
    } catch (error) {
      if (update !== themeUpdate) return;
      try { await globalThis.agentFactorySyntaxHighlighter?.configureTheme({}); } catch {}
      if (update !== themeUpdate) return;
      upsertThemeWarning(String(error));
    }
    if (update === themeUpdate) renderTimeline();
  }
  function upsertThemeWarning(message) {
    const existing = host.state.timeline.find(function (event) { return event.id === "syntax-theme-warning"; });
    if (existing) existing.text = message;
    else host.state.timeline.push({ type: "notice", id: "syntax-theme-warning", level: "warning", text: message });
  }
  function isHighContrast() {
    return document.body.classList.contains("vscode-high-contrast") ||
      document.body.classList.contains("vscode-high-contrast-light");
  }
  function currentSyntaxThemeClass() {
    return document.body.classList.contains("vscode-light") ||
      document.body.classList.contains("vscode-high-contrast-light")
      ? "light"
      : "dark";
  }
  function parseGitDiff(diff) {
    const files = [];
    let current;
    diff.split("\n").forEach(function (line) {
      if (line.startsWith("diff --git ")) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        current = { path: match ? match[2] : line.slice(11), additions: 0, deletions: 0 };
        files.push(current);
      } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
        current.additions += 1;
      } else if (current && line.startsWith("-") && !line.startsWith("---")) {
        current.deletions += 1;
      }
    });
    return files;
  }
  function gitDiffLineClass(line) {
    if (line.startsWith("+") && !line.startsWith("+++")) return "git-diff-line git-diff-addition";
    if (line.startsWith("-") && !line.startsWith("---")) return "git-diff-line git-diff-deletion";
    if (line.startsWith("@@")) return "git-diff-line git-diff-hunk";
    return "git-diff-line";
  }

  return {
    applySyntaxHighlighting,
    get syntaxRevision() { return syntaxRevision; },
    set syntaxRevision(value) { syntaxRevision = value; },
    updateSyntaxTheme, renderGitDiff
  };
};
