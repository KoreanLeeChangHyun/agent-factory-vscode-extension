import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

// Node already shares identical data-URL modules. Share the preceding build too.
// Each importer has its own fixed build options and worker-local cache. Nothing
// survives the test run; custom mocks cannot reuse a production bundle.
export function createTypeScriptBuilder(options = {}) {
  const bundles = new Map();
  return function buildTypeScript(relativePath) {
    const sourcePath = fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
    if (!bundles.has(sourcePath)) {
      const pending = build({
        bundle: true, format: 'esm', platform: 'node', target: 'node18',
        ...options, entryPoints: [sourcePath], write: false
      }).then(output => output.outputFiles[0].text);
      bundles.set(sourcePath, pending);
      pending.catch(() => { if (bundles.get(sourcePath) === pending) bundles.delete(sourcePath); });
    }
    return bundles.get(sourcePath);
  };
}

export function createTypeScriptImporter(options = {}) {
  const prepare = createTypeScriptBuilder(options);
  const imports = new Map();
  return function importTypeScript(relativePath) {
    if (!imports.has(relativePath)) {
      const pending = prepare(relativePath).then(source =>
        import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
      imports.set(relativePath, pending);
      pending.catch(() => { if (imports.get(relativePath) === pending) imports.delete(relativePath); });
    }
    return imports.get(relativePath);
  };
}

export const importTypeScript = createTypeScriptImporter();
