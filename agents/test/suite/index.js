"use strict";

const assert = require("node:assert/strict");
const vscode = require("vscode");

async function run() {
  const extension = vscode.extensions.getExtension(
    "agent-factory.agent-factory-agents",
  );
  assert.ok(extension, "development extension is discoverable");
  await extension.activate();

  const commands = await vscode.commands.getCommands(true);
  assert.ok(commands.includes("workbench.view.extension.agentFactoryAgents"));

  await vscode.commands.executeCommand(
    "workbench.view.extension.agentFactoryAgents",
  );
}

module.exports = { run };

