"use strict";

const { accessSync, constants, mkdirSync } = require("node:fs");
const { join } = require("node:path");

const extensionRoot = join(__dirname, "..");
const bundledCodex = join(
  extensionRoot,
  "node_modules",
  "@openai",
  "codex-linux-x64",
  "vendor",
  "x86_64-unknown-linux-musl",
  "bin",
  "codex",
);

try {
  accessSync(bundledCodex, constants.F_OK | constants.X_OK);
} catch {
  throw new Error(
    `Bundled Codex CLI is missing or not executable: ${bundledCodex}. Run npm ci before packaging.`,
  );
}

mkdirSync(join(extensionRoot, "dist"), { recursive: true });
