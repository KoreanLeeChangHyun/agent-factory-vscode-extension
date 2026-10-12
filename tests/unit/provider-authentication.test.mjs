import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { importTypeScript } from "../support/import-typescript.mjs";

const adapter = await importTypeScript("src/infrastructure/agent-factory/provider-authentication.ts");
const { ProviderAuthentication } = await importTypeScript("src/infrastructure/vscode/provider-authentication.ts");
const { parseClientMessage } = await importTypeScript("src/protocol/validator.ts");

const result = (exitCode, stdout = "", stderr = "") => ({ exitCode, stdout, stderr });

test("Codex status output maps only clear answers to signed in or signed out", () => {
  const { parseCodexAuthStatus: parse } = adapter;
  assert.deepEqual(parse(result(0, "", "Logged in using ChatGPT\n")), { state: "signed-in", method: "account" });
  const apiKey = parse(result(0, "", "Logged in using an API key - sk-proj-***ABCDE\n"));
  assert.deepEqual(apiKey, { state: "signed-in", method: "api-key" });
  assert.doesNotMatch(JSON.stringify(apiKey), /sk-|ABCDE/);
  assert.deepEqual(parse(result(1, "", "Not logged in\n")), { state: "signed-out" });
  // A failed read of the auth store is not a sign-out.
  assert.deepEqual(parse(result(1, "", "Error checking login status: permission denied\n")), { state: "unknown", reason: "error" });
  assert.deepEqual(parse(result(0, "unexpected")), { state: "unknown", reason: "error" });
  assert.deepEqual(parse(result(2, "", "error: unrecognized subcommand 'status'")), { state: "unknown", reason: "error" });
});

test("Claude status JSON distinguishes subscription, API key and signed-out without exposing account fields", () => {
  const { parseClaudeAuthStatus: parse } = adapter;
  const account = parse(result(0, JSON.stringify({ loggedIn: true, authMethod: "claude.ai", email: "person@example.com", orgId: "org-1" })));
  assert.deepEqual(account, { state: "signed-in", method: "account" });
  assert.doesNotMatch(JSON.stringify(account), /example|org-1/);
  assert.deepEqual(parse(result(0, JSON.stringify({ loggedIn: true, authMethod: "api_key", apiKeySource: "ANTHROPIC_API_KEY" }))), { state: "signed-in", method: "api-key" });
  assert.deepEqual(parse(result(1, JSON.stringify({ loggedIn: false, authMethod: "none" }))), { state: "signed-out" });
  assert.deepEqual(parse(result(1, "Not logged in. Run claude auth login to authenticate.")), { state: "unknown", reason: "error" });
  assert.deepEqual(parse(result(0, JSON.stringify({ authMethod: "claude.ai" }))), { state: "unknown", reason: "error" });
});

test("status checks report missing CLIs, unsupported checks, timeouts and errors as distinct states", async () => {
  const calls = [];
  const probe = async (executable, args) => { calls.push([executable, args]); return result(0, "", "Logged in using ChatGPT"); };
  assert.deepEqual(await adapter.probeProviderAuth("codex", undefined, probe), { state: "missing" });
  assert.deepEqual(await adapter.probeProviderAuth("antigravity", "/opt/agy", probe), { state: "unknown", reason: "unsupported", path: "/opt/agy" });
  assert.equal(calls.length, 0);
  assert.deepEqual(await adapter.probeProviderAuth("codex", "/opt/codex", probe), { state: "signed-in", method: "account", path: "/opt/codex" });
  assert.deepEqual(calls, [["/opt/codex", ["login", "status"]]]);
  await adapter.probeProviderAuth("claude", "/opt/claude", async (executable, args) => { calls.push([executable, args]); return result(1, '{"loggedIn":false}'); });
  assert.deepEqual(calls.at(-1), ["/opt/claude", ["auth", "status", "--json"]]);
  assert.deepEqual(await adapter.probeProviderAuth("codex", "/opt/codex", async () => ({ exitCode: null, stdout: "", stderr: "", timedOut: true })),
    { state: "unknown", reason: "timeout", path: "/opt/codex" });
  assert.deepEqual(await adapter.probeProviderAuth("codex", "/opt/codex", async () => ({ exitCode: null, stdout: "", stderr: "", error: true })),
    { state: "unknown", reason: "error", path: "/opt/codex" });
  assert.deepEqual(await adapter.probeProviderAuth("claude", "/opt/claude", async () => { throw new Error("spawn failed"); }),
    { state: "unknown", reason: "error", path: "/opt/claude" });
});

test("the real probe runs the fixture CLI without a shell, closes stdin and times out", { skip: process.platform === "win32" }, async () => {
  const base = await mkdtemp(join(tmpdir(), "af-provider-auth-"));
  try {
    // Spaces and shell metacharacters in the directory must reach execFile unchanged.
    const directory = join(base, "dir with space;$(touch pwned)&'q'");
    await mkdir(directory, { recursive: true });
    const cli = join(directory, "codex");
    await writeFile(cli, '#!/bin/sh\nif [ "$1 $2" = "login status" ]; then read -r line; echo "Not logged in" >&2; exit 1; fi\nexit 9\n');
    await chmod(cli, 0o755);
    const slow = join(directory, "slow");
    await writeFile(slow, "#!/bin/sh\nexec sleep 5\n");
    await chmod(slow, 0o755);
    assert.deepEqual(await adapter.probeProviderAuth("codex", cli, adapter.authProbe(5_000)), { state: "signed-out", path: cli });
    assert.deepEqual(await adapter.probeProviderAuth("codex", slow, adapter.authProbe(200)), { state: "unknown", reason: "timeout", path: slow });
    assert.deepEqual(await adapter.probeProviderAuth("codex", join(directory, "absent"), adapter.authProbe(5_000)),
      { state: "unknown", reason: "error", path: join(directory, "absent") });
    await assert.rejects(import("node:fs/promises").then(fs => fs.access(join(base, "pwned"))));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("sign-in commands run the configured executable directly with safe Windows batch quoting", () => {
  const { cliInvocation, loginTerminalLaunch } = adapter;
  assert.deepEqual(loginTerminalLaunch("codex", "/home/a b/$(x);bin/codex", "linux"), { file: "/home/a b/$(x);bin/codex", args: ["login"] });
  assert.deepEqual(loginTerminalLaunch("claude", "/Users/me/.local/bin/claude", "darwin"), { file: "/Users/me/.local/bin/claude", args: ["auth", "login"] });
  assert.deepEqual(loginTerminalLaunch("antigravity", "/home/me/.local/bin/agy", "linux"), { file: "/home/me/.local/bin/agy", args: [] });
  assert.deepEqual(loginTerminalLaunch("claude", "C:\\Program Files\\Claude\\claude.exe", "win32"), { file: "C:\\Program Files\\Claude\\claude.exe", args: ["auth", "login"] });
  assert.deepEqual(loginTerminalLaunch("codex", "C:\\Users\\A&B (x)\\npm\\codex.cmd", "win32", "C:\\Windows\\System32\\cmd.exe"),
    { file: "C:\\Windows\\System32\\cmd.exe", args: '/d /s /c ""C:\\Users\\A&B (x)\\npm\\codex.cmd" login"' });
  assert.equal(cliInvocation("C:\\Users\\%USERNAME%\\codex.cmd", ["login"], "win32"), undefined);
  assert.equal(cliInvocation("C:\\odd\"\\codex.bat", ["login"], "win32"), undefined);
  // Only Windows treats .cmd as a batch shim.
  assert.deepEqual(cliInvocation("/opt/tools/codex.cmd", ["login", "status"], "linux"), { file: "/opt/tools/codex.cmd", args: ["login", "status"] });
});

test("sign-in and refresh requests accept only known providers", () => {
  assert.deepEqual(parseClientMessage({ type: "providers.login", provider: "claude" }), { type: "providers.login", provider: "claude" });
  assert.equal(parseClientMessage({ type: "providers.login", provider: "bash" }), undefined);
  assert.deepEqual(parseClientMessage({ type: "providers.auth.request", provider: "codex" }), { type: "providers.auth.request" });
});

function fakeWindow() {
  const terminals = [];
  const closeListeners = new Set();
  return {
    terminals,
    close(terminal, code = 0) {
      terminal.exitStatus = { code };
      for (const listener of closeListeners) listener(terminal);
    },
    createTerminal(options) {
      const terminal = { options, shown: 0, disposed: false, exitStatus: undefined, show() { this.shown += 1; }, dispose() { this.disposed = true; } };
      terminals.push(terminal);
      return terminal;
    },
    onDidCloseTerminal(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    }
  };
}

function controller(overrides = {}) {
  const window = fakeWindow();
  const published = [];
  const probes = [];
  let statuses = overrides.statuses ?? [
    { id: "codex", detected: true, path: "/home/me/.local/bin/codex", source: "path" },
    { id: "claude", detected: true, path: "/opt/claude dir/claude", source: "configured", configuredPath: "/opt/claude dir/claude" },
    { id: "antigravity", detected: false }
  ];
  const auth = new ProviderAuthentication({
    window,
    statuses: () => statuses,
    publish: snapshot => { published.push(snapshot); },
    terminalName: id => `${id} sign-in`,
    probe: overrides.probe ?? (async (executable, args) => {
      probes.push([executable, args]);
      return executable.includes("claude") ? result(1, '{"loggedIn":false}') : result(0, "", "Logged in using ChatGPT");
    }),
    environment: () => overrides.environment ?? { PATH: "/selected/bin:/usr/bin", SECRET_TOKEN: "do-not-forward" },
    platform: overrides.platform ?? "linux"
  });
  return { auth, window, published, probes, setStatuses(value) { statuses = value; } };
}

test("a sign-in click opens one terminal with the detected executable and Work PATH, and re-clicks reuse it", async () => {
  const { auth, window, published, probes } = controller();
  assert.equal(auth.login("claude"), "started");
  assert.equal(window.terminals.length, 1);
  const [terminal] = window.terminals;
  assert.deepEqual(terminal.options, { name: "claude sign-in", shellPath: "/opt/claude dir/claude", shellArgs: ["auth", "login"], env: { PATH: "/selected/bin:/usr/bin" } });
  assert.equal(terminal.shown, 1);
  assert.deepEqual(published.at(-1).signingIn, ["claude"]);
  // Starting the terminal is not a sign-in: no status is assumed.
  assert.equal(published.at(-1).auth.claude, undefined);
  assert.equal(probes.length, 0);
  assert.equal(auth.login("claude"), "shown");
  assert.equal(auth.login("claude"), "shown");
  assert.equal(window.terminals.length, 1);
  assert.equal(terminal.shown, 3);
  // Closing the terminal asks the CLI again instead of trusting the exit.
  window.close(terminal, 0);
  await auth.refresh();
  assert.deepEqual(auth.snapshot().signingIn, []);
  assert.deepEqual(auth.snapshot().auth.claude, { state: "signed-out", path: "/opt/claude dir/claude" });
  assert.ok(probes.some(([executable]) => executable === "/opt/claude dir/claude"));
});

test("an exited but still open sign-in terminal is replaced, and missing CLIs never start one", () => {
  const { auth, window } = controller();
  auth.login("codex");
  const [first] = window.terminals;
  first.exitStatus = { code: 1 };
  assert.equal(auth.login("codex"), "started");
  assert.equal(first.disposed, true);
  assert.equal(window.terminals.length, 2);
  assert.equal(auth.login("antigravity"), "unavailable");
  assert.equal(window.terminals.length, 2);
});

test("remote and Windows hosts use the CLI chosen by that host's detection", () => {
  // In WSL/SSH/containers the extension host is remote; its detection picks the Linux CLI, never a /mnt/c copy.
  const wsl = controller({ statuses: [{ id: "codex", detected: true, path: "/home/me/.nvm/versions/node/v22.0.0/bin/codex", source: "nvm" }],
    environment: { PATH: "/home/me/.nvm/versions/node/v22.0.0/bin:/usr/bin:/mnt/c/Windows" } });
  wsl.auth.login("codex");
  assert.equal(wsl.window.terminals[0].options.shellPath, "/home/me/.nvm/versions/node/v22.0.0/bin/codex");
  assert.deepEqual(wsl.window.terminals[0].options.env, { PATH: "/home/me/.nvm/versions/node/v22.0.0/bin:/usr/bin:/mnt/c/Windows" });
  const windows = controller({ platform: "win32", statuses: [{ id: "codex", detected: true, path: "C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd" }],
    environment: { Path: "C:\\Users\\Me\\AppData\\Roaming\\npm;C:\\Windows" } });
  windows.auth.login("codex");
  const options = windows.window.terminals[0].options;
  assert.match(options.shellPath, /cmd(\.exe)?$/i);
  assert.equal(options.shellArgs, '/d /s /c ""C:\\Users\\Me\\AppData\\Roaming\\npm\\codex.cmd" login"');
  assert.deepEqual(options.env, { Path: "C:\\Users\\Me\\AppData\\Roaming\\npm;C:\\Windows" });
  const unsafe = controller({ platform: "win32", statuses: [{ id: "codex", detected: true, path: "C:\\%TEMP%\\codex.cmd" }] });
  assert.equal(unsafe.auth.login("codex"), "unavailable");
  assert.equal(unsafe.window.terminals.length, 0);
});

test("overlapping refreshes share one check, publish progress and drop results for a replaced path", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const { auth, published, setStatuses } = controller({ probe: async () => { calls += 1; await gate; return result(0, "", "Logged in using an API key - sk-***"); } });
  const first = auth.refresh();
  const second = auth.refresh();
  const third = auth.refresh();
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(published[0].checking, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 2);
  setStatuses([{ id: "codex", detected: true, path: "/new/codex" }, { id: "claude", detected: false }, { id: "antigravity", detected: false }]);
  release();
  await first;
  // One pass for the first request and one queued pass for the requests that overlapped it.
  assert.equal(calls, 2 + 1);
  const last = published.at(-1);
  assert.equal(last.checking, false);
  assert.deepEqual(last.auth, { codex: { state: "signed-in", method: "api-key", path: "/new/codex" }, claude: { state: "missing" }, antigravity: { state: "missing" } });
  assert.doesNotMatch(JSON.stringify(published), /sk-/);
});
