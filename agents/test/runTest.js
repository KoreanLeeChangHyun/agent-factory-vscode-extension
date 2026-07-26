"use strict";

const { join } = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const options = {
    extensionDevelopmentPath: [
      join(__dirname, ".."),
      join(__dirname, "..", "..", "workspace"),
    ],
    extensionTestsPath: join(__dirname, "suite", "index"),
    version: "1.129.1",
    launchArgs: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--headless",
      "--no-sandbox",
      "--ozone-platform=headless",
    ],
  };
  if (process.env.AGENT_FACTORY_VSCODE_TEST_CACHE_PATH) {
    options.cachePath = process.env.AGENT_FACTORY_VSCODE_TEST_CACHE_PATH;
  }
  await runTests(options);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
