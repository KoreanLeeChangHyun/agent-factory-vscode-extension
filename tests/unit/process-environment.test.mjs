import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import test from "node:test";

const output = await build({
  entryPoints: [fileURLToPath(new URL("../../src/infrastructure/agent-factory/process-environment.ts", import.meta.url))],
  bundle: true, format: "esm", platform: "node", target: "node18", write: false
});
const { runtimeEnvironment } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

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
  for (const platform of ["linux", "win32"]) {
    for (const environment of [{}, { PATH: "", Path: "C:\\Tools", CODEX_HOME: "/configured" }]) {
      assert.deepEqual(runtimeEnvironment(environment, platform), environment);
    }
  }
});
