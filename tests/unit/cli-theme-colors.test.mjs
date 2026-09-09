import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: [new URL("../../src/webview/cli-theme-colors.ts", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", target: "node18", write: false
});
const { normalizeCliTheme } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const rule = foreground => ({ scope: "keyword", settings: { foreground } });
const restored = (result, index = 0) => {
  const color = result.theme.settings[index].settings.foreground;
  return result.colors.get(color.toLowerCase()) ?? color;
};

test("CLI alpha markers restore named, bright, indexed and terminal default colors", () => {
  const result = normalizeCliTheme({ settings: [
    rule("#01000000"), rule("#09000000"), rule("#c4000000"), rule("#e8000000"), rule("#00000001")
  ] });
  assert.match(restored(result, 0), /^var\(--vscode-terminal-ansiRed,/);
  assert.match(restored(result, 1), /^var\(--vscode-terminal-ansiBrightRed,/);
  assert.equal(restored(result, 2), "rgb(255, 0, 0)");
  assert.equal(restored(result, 3), "rgb(8, 8, 8)");
  assert.equal(restored(result, 4), "var(--vscode-editor-foreground)");
  for (const color of result.colors.keys()) assert.match(color, /^#[0-9a-f]{6}$/);
});

test("CLI intermediate and opaque alpha become RGB while normal hex remains unchanged", () => {
  const result = normalizeCliTheme({ settings: [rule("#AAbbCC80"), rule("#123456ff"), rule("#C0ffee"), rule("#abc")] });
  assert.equal(restored(result, 0), "#AAbbCC");
  assert.equal(restored(result, 1), "#123456");
  assert.equal(restored(result, 2), "#C0ffee");
  assert.equal(restored(result, 3), "#abc");
  assert.equal(result.colors.size, 0);
});

test("terminal marker sentinels cannot collide with literal, shorthand or stripped RGB colors", () => {
  const result = normalizeCliTheme({
    settings: [rule("#000"), rule("#000001"), rule("#00000280"), rule("#01000000"), rule("#01000000")],
    colorReplacements: { "#abcabc": "#000003" }
  });
  const sentinel = result.theme.settings[3].settings.foreground;
  assert.equal(sentinel, "#000004");
  assert.equal(result.theme.settings[4].settings.foreground, sentinel);
  assert.equal(result.colors.size, 1);
  assert.equal(result.colors.has("#000002"), false);
});

test("custom tokenColors and global fields normalize without mutating the input", () => {
  const source = {
    name: "custom", fg: "#00000001", bg: "#111111", colors: { "editor.foreground": "#01000000", "editor.background": "#111111" },
    tokenColors: [{ scope: ["keyword", "storage"], settings: { foreground: "#02000000", background: "#abcdef", fontStyle: "bold italic" } }]
  };
  const snapshot = JSON.stringify(source);
  const { theme, colors } = normalizeCliTheme(source);
  assert.equal(JSON.stringify(source), snapshot);
  assert.equal(theme.bg, undefined);
  assert.equal(theme.colors["editor.background"], undefined);
  assert.equal(theme.tokenColors[0].settings.background, undefined);
  assert.equal(theme.tokenColors[0].settings.fontStyle, "bold italic");
  assert.deepEqual(theme.tokenColors[0].scope, ["keyword", "storage"]);
  assert.equal(colors.get(theme.fg), "var(--vscode-editor-foreground)");
  assert.match(colors.get(theme.colors["editor.foreground"]), /ansiRed/);
  assert.match(colors.get(theme.tokenColors[0].settings.foreground), /ansiGreen/);
});

test("all bundled CLI themes normalize without residual alpha or foreground collisions", async () => {
  const themes = JSON.parse(await readFile(new URL("../../src/webview/cli-themes.json", import.meta.url), "utf8"));
  assert.equal(Object.keys(themes).length, 32);
  for (const source of Object.values(themes)) {
    const result = normalizeCliTheme(source);
    for (const [index, rule] of result.theme.settings.entries()) {
      assert.equal(rule.settings.background, undefined);
      const original = source.settings[index].settings.foreground;
      if (!original) continue;
      assert.match(rule.settings.foreground, /^#[\da-f]{6}$/i);
      if (original.slice(7).toLowerCase() === "00" || original.slice(7).toLowerCase() === "01") {
        assert.ok(result.colors.has(rule.settings.foreground));
      } else assert.equal(result.colors.has(rule.settings.foreground.toLowerCase()), false);
    }
  }
});
