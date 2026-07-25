"use strict";

const { join } = require("node:path");
const { runTests } = require("@vscode/test-electron");

async function main() {
  await runTests({
    extensionDevelopmentPath: join(__dirname, ".."),
    extensionTestsPath: join(__dirname, "suite", "index"),
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

