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
const vscode = require("vscode");

const { AgentsChatController } = require("../../src/chatBackend");
const { CodexRunner } = require("../../src/codexAdapter");

async function run() {
  const extension = vscode.extensions.getExtension(
    "agent-factory.agent-factory-agents",
  );
  assert.ok(extension, "development extension is discoverable");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("workbench.view.extension.agentFactoryAgents"));
  assert.ok(commands.includes("agentFactoryAgents.chat.focus"));

  await vscode.commands.executeCommand(
    "workbench.view.extension.agentFactoryAgents",
  );
  await vscode.commands.executeCommand("agentFactoryAgents.chat.focus");
  await verifyFakeChatFlow();
}

async function verifyFakeChatFlow() {
  const directory = mkdtempSync(join(tmpdir(), "agent-factory-e2e-codex-"));
  try {
    const executable = join(directory, "codex");
    writeFileSync(
      executable,
      [
        "#!/usr/bin/env node",
        '"use strict";',
        'process.stdout.write(\'{"type":"thread.started","thread_id":"e2e-provider"}\\n\');',
        'process.stdout.write(\'{"type":"item.completed","item":{"type":"agent_message","text":"e2e response"}}\\n\');',
        'process.stdout.write(\'{"type":"turn.completed"}\\n\');',
      ].join("\n"),
    );
    chmodSync(executable, 0o755);

    let savedState;
    const posted = [];
    const controller = new AgentsChatController({
      runner: new CodexRunner({ executablePath: executable }),
      workspaceState: {
        get(_key, fallback) {
          return savedState || fallback;
        },
        async update(_key, value) {
          savedState = value;
        },
      },
      workspaceRoot: directory,
      postMessage: async (message) => posted.push(message),
    });
    await controller.handleMessage({
      type: "chat.submit",
      sessionId: "e2e-session",
      prompt: "hello",
    });
    await waitFor(
      () =>
        controller.snapshot().sessions["e2e-session"]?.status === "complete",
    );

    const session = controller.snapshot().sessions["e2e-session"];
    assert.equal(session.providerSessionId, "e2e-provider");
    assert.equal(session.messages.at(-1).text, "e2e response");
    assert.ok(posted.some((message) => message.type === "chat.snapshot"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

async function waitFor(predicate) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("Timed out waiting for fake Codex chat flow");
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

module.exports = { run };
