import { build, context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

async function prepareStaticVendor() {
  await mkdir("static/vendor", { recursive: true });
  await Promise.all([
    copyFile("node_modules/markdown-it/dist/markdown-it.min.js", "static/vendor/markdown-it.min.js"),
    copyFile("node_modules/plist/LICENSE", "static/vendor/plist.LICENSE.txt"),
    copyFile("node_modules/@iarna/toml/LICENSE", "static/vendor/toml.LICENSE.txt"),
    copyFile("node_modules/@xmldom/xmldom/LICENSE", "static/vendor/xmldom.LICENSE.txt"),
    copyFile("node_modules/markdown-it/LICENSE", "static/vendor/markdown-it.LICENSE.txt"),
    copyFile("node_modules/shiki/LICENSE", "static/vendor/shiki.LICENSE.txt"),
    copyFile("node_modules/@shikijs/langs/LICENSE", "static/vendor/shiki-langs.LICENSE.txt"),
    copyFile("node_modules/@shikijs/themes/LICENSE", "static/vendor/shiki-themes.LICENSE.txt"),
    copyFile("node_modules/@shikijs/engine-oniguruma/LICENSE", "static/vendor/shiki-oniguruma.LICENSE.txt"),
    copyFile("node_modules/@shikijs/vscode-textmate/LICENSE.md", "static/vendor/shiki-vscode-textmate.LICENSE.txt")
  ]);
}

const syntaxOptions = {
  entryPoints: ["src/webview/syntax-highlighter.ts"],
  bundle: true,
  outfile: "static/vendor/syntax-highlighter.js",
  format: "iife",
  platform: "browser",
  target: "chrome120",
  minify: true,
  sourcemap: false,
  logLevel: "info"
};

const options = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  external: ["vscode"],
  format: "cjs",
  platform: "node",
  target: "node18",
  sourcemap: process.env.NODE_ENV !== "production",
  logLevel: "info"
};

await prepareStaticVendor();

if (process.argv.includes("--watch")) {
  const [extensionContext, syntaxContext] = await Promise.all([context(options), context(syntaxOptions)]);
  await Promise.all([extensionContext.watch(), syntaxContext.watch()]);
  console.log("Watching extension sources...");
} else {
  await Promise.all([build(options), build(syntaxOptions)]);
}
