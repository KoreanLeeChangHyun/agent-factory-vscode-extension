import assert from "node:assert/strict";
import { build } from "esbuild";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const output = await build({
  entryPoints: [fileURLToPath(new URL("../../src/infrastructure/agent-factory/process-environment.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node18", write: false
});
const environmentModule = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const { codexExecutable, configureCodexCli, resolveCodexCli, runtimeEnvironment } = environmentModule;

async function executable(path) {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

test("macOS GUI child environment includes package managers without changing caller precedence or policy", () => {
  const environment = { PATH: "/custom/bin:/usr/bin:/opt/homebrew/bin", CODEX_HOME: "/Users/a b/.codex", AGENT_FACTORY_EXECUTION_POLICY: "caller-policy" };
  const result = runtimeEnvironment(environment, "darwin", "/Users/a b");
  assert.deepEqual(result, { ...environment, PATH: "/custom/bin:/usr/bin:/opt/homebrew/bin:/usr/local/bin:/Users/a b/.local/bin" });
  assert.equal(environment.PATH, "/custom/bin:/usr/bin:/opt/homebrew/bin");
});

test("missing macOS PATH gets absolute defaults without adding current directory", () => {
  const paths = runtimeEnvironment({}, "darwin", "/Users/test").PATH.split(":");
  assert.ok(paths.includes("/opt/homebrew/bin"));
  assert.ok(paths.includes("/usr/local/bin"));
  assert.ok(paths.includes("/usr/bin"));
  assert.ok(paths.every(path => path.startsWith("/")));
});

test("Linux and Windows child environments retain their exact PATH semantics", () => {
  configureCodexCli(undefined);
  for (const platform of ["linux", "win32"]) {
    for (const environment of [{}, { PATH: "", Path: "C:\\Tools", CODEX_HOME: "/configured" }]) {
      assert.deepEqual(runtimeEnvironment(environment, platform), environment);
    }
  }
});

test("PATH selection keeps existing precedence and is reused by child environments", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, "first"), second = join(root, "second");
  await mkdir(first); await mkdir(second);
  await executable(join(first, "codex")); await executable(join(second, "codex"));
  const selection = await resolveCodexCli({ environment: { PATH: `${first}:${second}` }, platform: "linux", homeDirectory: root });
  assert.equal(selection.executable, join(first, "codex"));
  assert.equal(selection.source, "path");
  configureCodexCli(selection);
  assert.equal(codexExecutable(), join(first, "codex"));
  assert.equal(runtimeEnvironment({ PATH: `${first}:${second}:/usr/bin` }, "linux", root).PATH, `${first}:${second}:/usr/bin`);
  configureCodexCli(undefined);
});

test("NVM-only discovery selects the highest stable semantic Node version and carries Node on PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-nvm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of ["v20.11.0", "v24.2.0-rc.1", "v24.1.3", "v22.12.0"]) {
    const bin = join(root, ".nvm", "versions", "node", version, "bin");
    await mkdir(bin, { recursive: true });
    await executable(join(bin, "codex"));
    await executable(join(bin, "node"));
  }
  const selection = await resolveCodexCli({ environment: { PATH: "/minimal" }, platform: "linux", homeDirectory: root });
  assert.equal(selection.nodeVersion, "v24.1.3");
  assert.equal(selection.source, "nvm");
  configureCodexCli(selection);
  const result = runtimeEnvironment({ PATH: "/minimal:/usr/bin" }, "linux", root);
  assert.equal(result.PATH, `${selection.binDirectory}:/minimal:/usr/bin`);
  configureCodexCli(undefined);
});

test("configured absolute executable wins and invalid explicit paths never fall back", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-configured-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pathBin = join(root, "path"), configuredBin = join(root, "configured");
  await mkdir(pathBin); await mkdir(configuredBin);
  await executable(join(pathBin, "codex")); await executable(join(configuredBin, "chosen-codex"));
  const environment = { PATH: pathBin };
  const selection = await resolveCodexCli({ configuredPath: join(configuredBin, "chosen-codex"), environment, platform: "linux", homeDirectory: root });
  assert.equal(selection.source, "configured");
  assert.equal(selection.executable, join(configuredBin, "chosen-codex"));
  await assert.rejects(resolveCodexCli({ configuredPath: "codex --version", environment, platform: "linux", homeDirectory: root }), /absolute executable path/);
  await assert.rejects(resolveCodexCli({ configuredPath: join(root, "missing"), environment, platform: "linux", homeDirectory: root }), /not an executable file/);
});

test("missing CLI is distinct and native Windows does not claim NVM managed-runtime discovery", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-missing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nvmBin = join(root, ".nvm", "versions", "node", "v24.1.0", "bin");
  await mkdir(nvmBin, { recursive: true });
  await executable(join(nvmBin, "codex")); await executable(join(nvmBin, "node"));
  await assert.rejects(resolveCodexCli({ environment: { Path: "C:\\missing" }, platform: "win32", homeDirectory: root }), /was not found/);
  await assert.rejects(resolveCodexCli({ environment: { PATH: "/missing" }, platform: "linux", homeDirectory: join(root, "other") }), /was not found/);
});
