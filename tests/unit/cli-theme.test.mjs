import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import { build } from "esbuild";

const bundleRoot = await mkdtemp(join(tmpdir(), "af-cli-theme-bundle-"));
test.after(() => rm(bundleRoot, { recursive: true, force: true }));
const outfile = join(bundleRoot, "theme.cjs");
await build({ entryPoints: [new URL("../../src/infrastructure/agent-factory/cli-theme.ts", import.meta.url).pathname], outfile, bundle: true, platform: "node", format: "cjs", target: "node18" });
const { readCliTheme } = createRequire(import.meta.url)(outfile);

async function fixture(t, config) {
  const home = await mkdtemp(join(tmpdir(), "af-cli-theme-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "themes"));
  if (config !== undefined) await writeFile(join(home, "config.toml"), config);
  return home;
}

const theme = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>name</key><string>Display Name</string><key>settings</key><array>
<dict><key>settings</key><dict><key>foreground</key><string>#eeeeee</string><key>background</key><string>#121212</string></dict></dict>
<dict><key>scope</key><string>keyword, storage.type</string><key>settings</key><dict><key>foreground</key><string>#ff0000</string><key>fontStyle</key><string>bold italic</string></dict></dict>
</array></dict></plist>`;

test("missing configuration and unselected themes use the default", async (t) => {
  assert.deepEqual(await readCliTheme(await fixture(t)), {});
  assert.deepEqual(await readCliTheme(await fixture(t, '[tui]\nnotifications = true')), {});
});

test("TOML table, dotted and quoted keys preserve selected built-in names", async (t) => {
  for (const config of ['[tui]\ntheme = "dracula" # comment', 'tui.theme = "dracula"', '"tui"."theme" = \'dracula\'']) {
    assert.deepEqual(await readCliTheme(await fixture(t, config)), { name: "dracula" });
  }
});

test("custom tmTheme keeps global styles and token scopes without trusting its display name", async (t) => {
  const home = await fixture(t, '[tui]\ntheme = "my-theme"');
  await writeFile(join(home, "themes", "my-theme.tmTheme"), theme);
  const result = await readCliTheme(home);
  assert.equal(result.error, undefined);
  assert.equal(result.theme.name, "my-theme");
  assert.equal(result.theme.settings[0].settings.background, "#121212");
  assert.equal(result.theme.settings[1].scope, "keyword, storage.type");
  assert.equal(result.theme.settings[1].settings.fontStyle, "bold italic");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test("custom filenames match exactly and built-in themes take precedence", async (t) => {
  const home = await fixture(t, 'tui.theme = "My Theme"');
  await writeFile(join(home, "themes", "My Theme.tmTheme"), theme);
  assert.equal((await readCliTheme(home)).theme.name, "My Theme");
  await writeFile(join(home, "themes", "dracula.tmTheme"), "invalid XML");
  await writeFile(join(home, "config.toml"), 'tui.theme = "dracula"');
  assert.deepEqual(await readCliTheme(home), { name: "dracula" });
});

test("invalid TOML and non-string theme produce recoverable errors", async (t) => {
  for (const config of ['[tui\ntheme = "x"', '[tui]\ntheme = 12']) {
    assert.ok((await readCliTheme(await fixture(t, config))).error);
  }
});

test("malformed, invalid and entity-declaring custom themes fail closed", async (t) => {
  const home = await fixture(t, 'tui.theme = "custom"');
  for (const xml of ['<plist><dict>', '<plist><dict><key>settings</key><string>wrong</string></dict></plist>', theme.replace('<plist version=', '<!ENTITY secret SYSTEM "file:///etc/passwd"><plist version=')]) {
    await writeFile(join(home, "themes", "custom.tmTheme"), xml);
    const result = await readCliTheme(home);
    assert.ok(result.error);
    assert.equal(result.theme, undefined);
  }
});

test("theme reads reject oversized files and escaping paths", async (t) => {
  const home = await fixture(t, 'tui.theme = "huge"');
  await writeFile(join(home, "themes", "huge.tmTheme"), " ".repeat(2 * 1024 * 1024 + 1));
  assert.match((await readCliTheme(home)).error, /2 MiB/);
  await writeFile(join(home, "config.toml"), 'tui.theme = "../outside"');
  assert.match((await readCliTheme(home)).error, /Invalid theme name/);
  await writeFile(join(home, "outside.tmTheme"), theme);
  await symlink(join(home, "outside.tmTheme"), join(home, "themes", "escape.tmTheme"));
  await writeFile(join(home, "config.toml"), 'tui.theme = "escape"');
  assert.match((await readCliTheme(home)).error, /escapes/);
});
