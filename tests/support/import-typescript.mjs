import { build } from 'esbuild';

// Node already shares identical data-URL modules. Share the preceding build too.
// This cache lives only within one test worker; nothing survives the test run.
const imports = new Map();
export function importTypeScript(relativePath) {
  const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
  if (!imports.has(sourcePath)) {
    const pending = build({
      entryPoints: [sourcePath], bundle: true, format: 'esm',
      platform: 'node', target: 'node18', write: false
    }).then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));
    imports.set(sourcePath, pending);
    pending.catch(() => { if (imports.get(sourcePath) === pending) imports.delete(sourcePath); });
  }
  return imports.get(sourcePath);
}
