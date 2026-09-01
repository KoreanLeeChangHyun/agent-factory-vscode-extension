import { build, context } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";

async function prepareStaticVendor() {
  await mkdir("static/vendor", { recursive: true });
  await Promise.all([
    copyFile("node_modules/markdown-it/dist/markdown-it.min.js", "static/vendor/markdown-it.min.js"),
    copyFile("node_modules/markdown-it/LICENSE", "static/vendor/markdown-it.LICENSE.txt")
  ]);
}

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
  const buildContext = await context(options);
  await buildContext.watch();
  console.log("Watching extension sources...");
} else {
  await build(options);
}
