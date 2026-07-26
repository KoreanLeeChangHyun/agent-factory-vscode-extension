"use strict";

const assert = require("node:assert/strict");
const {
  chmodSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");

const { CodexRunner } = require("../../src/codexAdapter");

test("CodexRunner consumes JSONL from a real fake executable process", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "agent-factory-fake-codex-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const executable = join(directory, "codex");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      '"use strict";',
      'process.stdout.write(\'{"type":"thread.started","thread_id":"fake-provider"}\\n\');',
      'process.stdout.write(\'{"type":"item.completed","item":{"type":"agent_message","text":"fake response"}}\\n\');',
      'process.stdout.write(\'{"type":"turn.completed","usage":{"input_tokens":2}}\\n\');',
    ].join("\n"),
  );
  chmodSync(executable, 0o755);

  const events = [];
  const runner = new CodexRunner({ executablePath: executable });
  await runner.run({
    sessionId: "integration-session",
    prompt: "hello",
    cwd: directory,
    onEvent: (event) => events.push(event),
  });

  assert.deepEqual(events, [
    { type: "session", providerSessionId: "fake-provider" },
    { type: "assistant.message", text: "fake response" },
    { type: "complete", usage: { input_tokens: 2 } },
  ]);
});
