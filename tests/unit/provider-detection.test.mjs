import assert from "node:assert/strict";
import { build } from "esbuild";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

async function load(relativePath) {
  const output = await build({
    entryPoints: [fileURLToPath(new URL(`../../${relativePath}`, import.meta.url))],
    bundle: true, format: "esm", platform: "node", target: "node18", write: false
  });
  return import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
}

const detection = await load("src/infrastructure/agent-factory/provider-detection.ts");

test("provider plugin freshness compares release versions without build metadata", () => {
  assert.equal(detection.pluginVersionIsCurrent("1.0.21+codex.20261001", "1.0.21"), true);
  assert.equal(detection.pluginVersionIsCurrent("1.0.20", "1.0.21"), false);
  assert.equal(detection.pluginVersionIsCurrent(undefined, "1.0.21"), false);
});

test("specific Antigravity installation is safe only when the requested version is already installed", () => {
  assert.equal(detection.canInstallSpecificPluginVersion("antigravity", "1.0.20", "1.0.20+build.2"), true);
  assert.equal(detection.canInstallSpecificPluginVersion("antigravity", "1.0.21", "1.0.20"), false);
  assert.equal(detection.canInstallSpecificPluginVersion("codex", undefined, "1.0.20"), true);
  assert.equal(detection.canInstallSpecificPluginVersion("claude", undefined, "1.0.20"), true);
});

async function executable(path) {
  await writeFile(path, "#!/bin/sh\nexit 0\n");
  await chmod(path, 0o755);
}

test("each provider is detected independently with its path, source and manual override state", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "af-providers-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), manual = join(root, "manual");
  await mkdir(bin); await mkdir(manual);
  await executable(join(bin, "codex"));
  await executable(join(manual, "agy-custom"));
  const changes = [];
  const subscription = detection.onProvidersChanged(statuses => changes.push(statuses));
  t.after(() => subscription.dispose());
  const statuses = await detection.detectProviders(
    { codex: join(root, "missing-codex"), antigravity: join(manual, "agy-custom") },
    { environment: { PATH: bin }, platform: "linux", homeDirectory: root, terminalPath: async () => [], probe: async () => true });
  const byId = Object.fromEntries(statuses.map(status => [status.id, status]));
  assert.deepEqual(statuses.map(status => status.id), ["codex", "claude", "antigravity"]);
  assert.equal(byId.codex.detected, true);
  assert.equal(byId.codex.path, join(bin, "codex"));
  assert.equal(byId.codex.source, "path");
  // An unusable manual path is reported while automatic detection keeps the provider usable.
  assert.equal(byId.codex.configuredInvalid, true);
  assert.equal(byId.antigravity.path, join(manual, "agy-custom"));
  assert.equal(byId.antigravity.source, "configured");
  assert.equal(byId.antigravity.configuredInvalid, false);
  assert.equal(detection.isProviderDetected("antigravity"), true);
  assert.deepEqual(changes.at(-1), statuses);
});

test("provider path messages accept a bounded path or an empty reset only for known providers", async () => {
  const { parseClientMessage } = await load("src/protocol/validator.ts");
  assert.deepEqual(parseClientMessage({ type: "providers.configure", provider: "antigravity", path: "/opt/agy" }),
    { type: "providers.configure", provider: "antigravity", path: "/opt/agy" });
  assert.deepEqual(parseClientMessage({ type: "providers.configure", provider: "claude", path: "" }),
    { type: "providers.configure", provider: "claude", path: "" });
  assert.equal(parseClientMessage({ type: "providers.configure", provider: "gemini", path: "/x" }), undefined);
  assert.equal(parseClientMessage({ type: "providers.configure", provider: "codex", path: "/x\n--flag" }), undefined);
  assert.equal(parseClientMessage({ type: "providers.configure", provider: "codex", path: "x".repeat(4097) }), undefined);
  assert.deepEqual(parseClientMessage({ type: "providers.pick", provider: "codex" }), { type: "providers.pick", provider: "codex" });
  assert.equal(parseClientMessage({ type: "providers.pick", provider: "gemini" }), undefined);
  assert.deepEqual(parseClientMessage({ type: "providers.detect" }), { type: "providers.detect" });
  assert.deepEqual(parseClientMessage({ type: "providers.update" }), { type: "providers.update" });
  assert.deepEqual(parseClientMessage({ type: "providers.update", provider: "codex", version: "1.0.20+codex.7" }),
    { type: "providers.update", provider: "codex", version: "1.0.20+codex.7" });
  assert.equal(parseClientMessage({ type: "providers.update", version: "1.0.20" }), undefined);
  assert.equal(parseClientMessage({ type: "providers.update", provider: "unknown", version: "1.0.20" }), undefined);
  assert.equal(parseClientMessage({ type: "providers.update", provider: "claude" }), undefined);
  assert.equal(parseClientMessage({ type: "providers.update", version: "latest" }), undefined);
  assert.equal(parseClientMessage({ type: "providers.update", version: "1.0.20\n--force" }), undefined);
  assert.deepEqual(parseClientMessage({ type: "providers.request" }), { type: "providers.request" });
});
