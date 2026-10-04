import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";

const AgentFactoryI18n = createRequire(import.meta.url)("../../static/js/localization.js");
const context = { AgentFactoryI18n, URL };
runInNewContext(await readFile(new URL("../../static/js/execution-references.js", import.meta.url), "utf8"), context);
runInNewContext(await readFile(new URL("../../static/js/chat/activity-rows.js", import.meta.url), "utf8"), context);
const rows = context.agentFactoryActivityRows;
const plain = value => JSON.parse(JSON.stringify(value));
const classify = text => plain(rows.classifyCommand(text));
const describe = event => plain(rows.describe(event));

test("shell commands classify into read, search, list, git, test and run with their targets", () => {
  assert.deepEqual(classify("sed -n '1770,1940p' static/js/chat.js"), { kind: "read", target: "static/js/chat.js", lineStart: 1770, lineEnd: 1940 });
  assert.deepEqual(classify("cd /repo && cat a.md b.md"), { kind: "read", target: "a.md, b.md" });
  assert.deepEqual(classify("head -n 40 README.md"), { kind: "read", target: "README.md", lineStart: 1, lineEnd: 40 });
  assert.deepEqual(classify("rg -n \"run.activity\" static/js src"), { kind: "search", target: "run.activity", scope: "static/js, src" });
  assert.deepEqual(classify("grep -rn -e 'a b' docs"), { kind: "search", target: "a b", scope: "docs" });
  assert.deepEqual(classify("rg --files plugin/runtime | head"), { kind: "list", target: "plugin/runtime" });
  assert.deepEqual(classify("ls static/css/chat"), { kind: "list", target: "static/css/chat" });
  assert.deepEqual(classify("find plugin -name '*.py' -newer x"), { kind: "list", target: "*.py", scope: "plugin" });
  assert.deepEqual(classify("git status --short"), { kind: "git", target: "git status --short" });
  assert.deepEqual(classify("npm test -- --test-name-pattern activity"), { kind: "test", target: "npm test -- --test-name-pattern activity" });
  assert.deepEqual(classify("cd extension && node --test tests/unit/a.test.mjs"), { kind: "test", target: "node --test tests/unit/a.test.mjs" });
  assert.deepEqual(classify("PYTHONPATH=runtime python3 -m pytest -q tests"), { kind: "test", target: "PYTHONPATH=runtime python3 -m pytest -q tests" });
  assert.deepEqual(classify("python3 - <<'PY'\nprint(1)\nPY"), { kind: "run", target: "python3 - <<'PY' …" });
  assert.deepEqual(classify("npm run build"), { kind: "run", target: "npm run build" });
  // A sed without a print range is an edit or transform, not a read.
  assert.equal(classify("sed -i 's/a/b/' file").kind, "run");
});

test("diffs split into one row per file with their own counts", () => {
  const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ b/a.ts", "@@ -1 +1,2 @@", "-x", "+y", "+z",
    "diff --git a/b.css b/b.css", "--- a/b.css", "+++ b/b.css", "@@ -1 +1 @@", "-p", "+q"].join("\n");
  const events = describe({ type: "activity", id: "e", category: "file", phase: "completed", text: "a.ts, b.css", diff });
  assert.deepEqual(events.map(row => [row.key, row.kind, row.target, row.stats]), [
    ["0", "edit", "a.ts", { additions: 2, deletions: 1 }],
    ["1", "edit", "b.css", { additions: 1, deletions: 1 }]
  ]);
  assert.ok(events[1].diff.startsWith("diff --git a/b.css") && !events[1].diff.includes("a.ts"));
  assert.deepEqual(describe({ type: "activity", id: "s", category: "file", phase: "started", text: "a.ts" }).map(row => [row.kind, row.target]), [["edit", "a.ts"]]);
});

test("host details take precedence and failures carry an exit code and one error line", () => {
  const [read] = describe({ type: "activity", category: "tool", phase: "completed", text: "claude/Read", kind: "read", target: "src/a.py", lineStart: 120, lineEnd: 159 });
  assert.deepEqual([read.kind, read.target, read.path, read.result], ["read", "src/a.py", true, { key: "activity.result.lines.range", values: [120, 159] }]);
  const [search] = describe({ type: "activity", category: "tool", phase: "completed", text: "claude/Grep", kind: "search", target: "TODO", scope: "src",
    output: "Found 3 files\na\nb\nc" });
  assert.deepEqual([search.target, search.scope, search.result], ["\"TODO\"", "src", { key: "diff.files", values: [3] }]);
  const failure = { type: "activity", category: "command", phase: "failed", text: "npm test", exitCode: 1,
    output: "▶ suite\n  ✖ groups reads\n✖ 1 failing test\n" };
  const [test] = describe(failure);
  assert.deepEqual([test.kind, test.result], ["test", [{ key: "activity.result.exit", values: [1] }, { key: "activity.result.output", values: [3] }]]);
  assert.equal(rows.errorLine(failure), "✖ 1 failing test");
  assert.equal(rows.errorLine({ ...failure, error: "Exit code 1\nAssertionError: expected 1" }), "AssertionError: expected 1");
  const [web] = describe({ type: "activity", category: "tool", phase: "completed", text: "https://github.com/openai/codex/blob/main/codex-rs/tui/src/exec_cell/render.rs", kind: "page" });
  assert.equal(web.target, "github.com/openai/…/exec_cell/render.rs");
  const [tool] = describe({ type: "activity", category: "tool", phase: "completed", text: "playwright/browser_take_screenshot", kind: "tool", scope: "a.png" });
  assert.deepEqual([tool.kind, tool.target, tool.argument], ["tool", "playwright · browser_take_screenshot", "a.png"]);
  const [thinking] = describe({ type: "activity", category: "tool", phase: "completed", text: "Reasoning", kind: "think", summary: "**Plan**" });
  assert.deepEqual([thinking.kind, thinking.detail], ["think", "summary"]);
  assert.equal(describe({ type: "activity", category: "tool", phase: "completed", text: "Reasoning", kind: "think" })[0].detail, undefined);
});

test("saved history without row fields still renders with a classified target", () => {
  const legacy = [
    { type: "activity", id: "a", category: "command", phase: "completed", text: "sed -n 1,193p static/js/chat/terminal.js", output: "x" },
    { type: "activity", id: "b", category: "tool", phase: "completed", text: "claude/Read" },
    { type: "activity", id: "c", category: "tool", phase: "completed", title: "웹 검색", text: "Codex CLI exec cell" },
    { type: "activity", id: "d", category: "tool", phase: "started", title: "Open webpage", text: "https://example.com/" },
    { type: "activity", id: "e", category: "tool", phase: "completed", text: "codex/list_mcp_resources" },
    { type: "activity", id: "f", category: "command", phase: "completed", title: "Read Skill · agent-factory:agent",
      text: "sed -n '1,240p' /home/test/.codex/plugins/cache/personal/agent-factory/0.1.0/skills/agent/SKILL.md" },
    { type: "activity", id: "g", category: "file", phase: "completed", text: "example.py" }
  ];
  assert.deepEqual(legacy.map(event => describe(event).map(row => [row.kind, row.phase, row.target])[0]), [
    ["read", "completed", "static/js/chat/terminal.js"],
    ["read", "completed", "Read"],
    ["web", "completed", "Codex CLI exec cell"],
    ["page", "started", "example.com"],
    ["tool", "completed", "codex · list_mcp_resources"],
    ["skill", "completed", "agent-factory:agent"],
    ["edit", "completed", "example.py"]
  ]);
});
