import assert from "node:assert/strict";
import { build } from "esbuild";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const output = await build({
  entryPoints: [fileURLToPath(new URL("../../src/infrastructure/agent-factory/process-environment.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node18", write: false
});
const environmentModule = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const { codexExecutable, configureCodexCli, resolveCodexCli, runtimeEnvironment, resolveClaudeCli, claudeExecutable, configureClaudeCli } = environmentModule;

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

test("configured absolute executable wins and unusable overrides fall back to the codex command", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-configured-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const pathBin = join(root, "path"), configuredBin = join(root, "configured");
  await mkdir(pathBin); await mkdir(configuredBin);
  await executable(join(pathBin, "codex")); await executable(join(configuredBin, "chosen-codex"));
  const environment = { PATH: pathBin };
  const selection = await resolveCodexCli({ configuredPath: join(configuredBin, "chosen-codex"), environment, platform: "linux", homeDirectory: root });
  assert.equal(selection.source, "configured");
  assert.equal(selection.executable, join(configuredBin, "chosen-codex"));
  // Unusable overrides (arguments, missing files, another host's Windows path) fall back to command discovery.
  for (const configuredPath of ["codex --version", join(root, "missing"), "C:/Users/Admin/codex.exe"]) {
    const fallback = await resolveCodexCli({ configuredPath, environment, platform: "linux", homeDirectory: root });
    assert.notEqual(fallback.source, "configured", configuredPath);
  }
});

test("Linux host finds a user-local standalone symlink with a minimal or missing PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-local-"));
  t.after(() => { configureCodexCli(undefined); return rm(root, { recursive: true, force: true }); });
  const bin = join(root, ".local", "bin");
  await mkdir(bin, { recursive: true });
  const target = join(root, "standalone-codex");
  await executable(target);
  await symlink(target, join(bin, "codex"));
  for (const environment of [{ PATH: "/usr/bin:/bin" }, {}]) {
    const selection = await resolveCodexCli({ environment, platform: "linux", homeDirectory: root });
    assert.equal(selection.executable, join(bin, "codex"));
    assert.equal(selection.source, "local");
    configureCodexCli(selection);
    assert.equal(runtimeEnvironment(environment, "linux", root).PATH.split(":")[0], bin);
  }
  await chmod(target, 0o644);
  await assert.rejects(resolveCodexCli({ environment: {}, platform: "linux", homeDirectory: root }), /was not found/);
  await rm(target);
  await assert.rejects(resolveCodexCli({ environment: {}, platform: "linux", homeDirectory: root }), /was not found/);
});

test("PATH and NVM keep precedence over a user-local installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-codex-precedence-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const local = join(root, ".local", "bin");
  const nvm = join(root, ".nvm", "versions", "node", "v24.1.0", "bin");
  const path = join(root, "path");
  for (const bin of [local, nvm, path]) {
    await mkdir(bin, { recursive: true });
    await executable(join(bin, "codex"));
  }
  await executable(join(nvm, "node"));
  assert.equal((await resolveCodexCli({ environment: { PATH: path }, platform: "linux", homeDirectory: root })).source, "path");
  assert.equal((await resolveCodexCli({ environment: {}, platform: "linux", homeDirectory: root })).source, "nvm");
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

test("Claude CLI resolves from the configured path, PATH, then the user-local install", async () => {
  const root = await mkdtemp(join(tmpdir(), "af-claude-cli-"));
  try {
    const onPath = join(root, "path-bin");
    const local = join(root, ".local", "bin");
    await mkdir(onPath, { recursive: true });
    await mkdir(local, { recursive: true });
    for (const file of [join(onPath, "claude"), join(local, "claude"), join(root, "chosen-claude")]) {
      await writeFile(file, "#!/bin/sh\n");
      await chmod(file, 0o755);
    }
    assert.equal(await resolveClaudeCli({ configuredPath: join(root, "chosen-claude"), environment: { PATH: onPath }, platform: "linux", homeDirectory: root }), join(root, "chosen-claude"));
    assert.equal(await resolveClaudeCli({ configuredPath: "claude", environment: { PATH: onPath }, platform: "linux", homeDirectory: root }), join(onPath, "claude"));
    assert.equal(await resolveClaudeCli({ environment: { PATH: onPath }, platform: "linux", homeDirectory: root }), join(onPath, "claude"));
    assert.equal(await resolveClaudeCli({ environment: { PATH: "/minimal" }, platform: "linux", homeDirectory: root }), join(local, "claude"));
    await rm(join(local, "claude"));
    assert.equal(await resolveClaudeCli({ environment: { PATH: "/minimal" }, platform: "linux", homeDirectory: root }), undefined);
    configureClaudeCli(join(root, "chosen-claude"));
    assert.equal(claudeExecutable(), join(root, "chosen-claude"));
    configureClaudeCli(undefined);
    assert.equal(claudeExecutable(), "claude");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows npm global shims resolve to the native Codex and Claude binaries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-npm-shim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const npmBin = join(root, "AppData", "Roaming", "npm");
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const codex = join(npmBin, "node_modules/@openai/codex/node_modules/@openai", `codex-win32-${architecture}`,
    "vendor/x86_64-pc-windows-msvc/bin/codex.exe");
  const claude = join(npmBin, "node_modules/@anthropic-ai/claude-code/bin/claude.exe");
  for (const file of [join(npmBin, "codex.cmd"), join(npmBin, "claude.cmd"), codex, claude]) {
    await mkdir(dirname(file), { recursive: true });
    await executable(file);
  }
  // The npm directory is found through APPDATA even when PATH omits it.
  const environment = { PATH: join(root, "empty"), APPDATA: join(root, "AppData", "Roaming") };
  const selection = await resolveCodexCli({ environment, platform: "win32", homeDirectory: root });
  assert.deepEqual([selection.executable, selection.source], [codex, "local"]);
  assert.equal(await resolveClaudeCli({ environment, platform: "win32", homeDirectory: root }), claude);
});

test("a terminal-only PATH entry is found when the extension host PATH is minimal (macOS GUI, SSH, containers)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-terminal-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const shellOnly = join(root, "custom-npm-prefix", "bin");
  await mkdir(shellOnly, { recursive: true });
  await executable(join(shellOnly, "codex")); await executable(join(shellOnly, "claude"));
  const options = { environment: { PATH: "/usr/bin" }, platform: "linux", homeDirectory: root, terminalPath: async () => [shellOnly] };
  const selection = await resolveCodexCli(options);
  assert.deepEqual([selection.executable, selection.source], [join(shellOnly, "codex"), "shell"]);
  assert.equal(await resolveClaudeCli(options), join(shellOnly, "claude"));
});

test("WSL prefers Linux installs over Windows entries appended to PATH", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-wsl-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const linuxBin = join(root, "linux-bin");
  await mkdir(linuxBin); await executable(join(linuxBin, "codex"));
  const windowsEntry = "/mnt/c/Users/Admin/AppData/Roaming/npm";
  const selection = await resolveCodexCli({ environment: { PATH: `${windowsEntry}:${linuxBin}`, WSL_DISTRO_NAME: "Ubuntu" },
    platform: "linux", homeDirectory: root, probe: async () => true });
  assert.equal(selection.executable, join(linuxBin, "codex"));
});

test("a candidate that does not start is skipped in favor of the next working installation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const broken = join(root, "broken"), working = join(root, ".local", "bin");
  await mkdir(broken); await mkdir(working, { recursive: true });
  await executable(join(broken, "codex")); await executable(join(working, "codex"));
  const options = { environment: { PATH: broken }, platform: "linux", homeDirectory: root };
  assert.equal((await resolveCodexCli({ ...options, probe: async path => !path.startsWith(broken) })).executable, join(working, "codex"));
  // With no working candidate, the first installation is still reported rather than hidden.
  assert.equal((await resolveCodexCli({ ...options, probe: async () => false })).executable, join(broken, "codex"));
});

test("fnm-managed Node versions are discovered like nvm", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-fnm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, ".local/share/fnm/node-versions/v22.3.0/installation/bin");
  await mkdir(bin, { recursive: true });
  await executable(join(bin, "codex")); await executable(join(bin, "node"));
  const selection = await resolveCodexCli({ environment: { PATH: "" }, platform: "linux", homeDirectory: root });
  assert.deepEqual([selection.executable, selection.source, selection.nodeVersion], [join(bin, "codex"), "nvm", "v22.3.0"]);
});

test("Windows Claude native installer, pnpm shims and a stale Windows override all resolve without a shell", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-windows-variants-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeClaude = join(root, ".local", "bin", "claude.exe");
  await mkdir(dirname(nativeClaude), { recursive: true }); await executable(nativeClaude);
  // pnpm keeps packages outside the shim directory; the shim text points at them.
  const pnpmHome = join(root, "pnpm");
  const store = join(pnpmHome, "global", "5", "node_modules", "@openai", "codex");
  const codex = join(store, "node_modules", "@openai", `codex-win32-${process.arch === "arm64" ? "arm64" : "x64"}`,
    "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe");
  await mkdir(dirname(codex), { recursive: true }); await executable(codex);
  await writeFile(join(pnpmHome, "codex.cmd"), '@"%~dp0\\global\\5\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n');
  await chmod(join(pnpmHome, "codex.cmd"), 0o755);
  const environment = { PATH: "", PNPM_HOME: pnpmHome, USERPROFILE: root };
  const options = { environment, platform: "win32", homeDirectory: root, configuredPath: "D:/old/codex.exe" };
  assert.equal((await resolveCodexCli(options)).executable, codex);
  assert.equal(await resolveClaudeCli(options), nativeClaude);
});
