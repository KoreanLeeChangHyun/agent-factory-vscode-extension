import { build } from 'esbuild';

// Node already shares identical data-URL modules. Share the preceding build too.
// Each importer has its own fixed build options and worker-local cache. Nothing
// survives the test run; custom mocks cannot reuse a production bundle.
export function createTypeScriptImporter(options = {}) {
  const imports = new Map();
  return function importTypeScript(relativePath) {
    const sourcePath = new URL(`../../${relativePath}`, import.meta.url).pathname;
    if (!imports.has(sourcePath)) {
      const pending = build({
        bundle: true, format: 'esm', platform: 'node', target: 'node18',
        ...options, entryPoints: [sourcePath], write: false
      }).then(output => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`));
      imports.set(sourcePath, pending);
      pending.catch(() => { if (imports.get(sourcePath) === pending) imports.delete(sourcePath); });
    }
    return imports.get(sourcePath);
  };
}

export const importTypeScript = createTypeScriptImporter();
