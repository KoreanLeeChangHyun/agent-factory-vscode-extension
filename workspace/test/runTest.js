"use strict";

const { join } = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  const extensionDevelopmentPath = join(__dirname, "..");
  const extensionTestsPath = join(__dirname, "suite", "index");

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    version: "1.129.1",
    launchArgs: [
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--headless",
      "--no-sandbox",
      "--ozone-platform=headless",
    ],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
