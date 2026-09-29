import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { importTypeScript } from '../support/import-typescript.mjs';

test('connection host coalesces starts, preserves caller environment, and closes with owner', async () => {
  const api = await importTypeScript('src/infrastructure/agent-factory/codex-connection-host.ts');
  const root = await mkdtemp(join(tmpdir(), 'af-pool-host-'));
  const transport = join(root, 'runtime/adapters/codex');
  const stopped = join(root, 'stopped');
  await mkdir(transport, { recursive: true });
  await writeFile(join(transport, 'transport.py'), `import sys,json,os\nfrom pathlib import Path\ndef connection_host(): pass\nprint(json.dumps({'port':1234,'token':str(os.getpid())}),flush=True)\nsys.stdin.read()\nPath(${JSON.stringify(stopped)}).write_text('closed')\n`);
  try {
    const [one,two] = await Promise.all([
      api.codexConnectionEnvironment('python3',join(root,'scripts/exec.py'),{...process.env, TEST:'one'}),
      api.codexConnectionEnvironment('python3',join(root,'scripts/exec.py'),{...process.env, TEST:'two'})
    ]);
    assert.equal(one.AGENT_FACTORY_CODEX_POOL,two.AGENT_FACTORY_CODEX_POOL);
    assert.equal(one.TEST,'one'); assert.equal(two.TEST,'two');
    api.disposeCodexConnections();
    const deadline=Date.now()+5000;
    while (await readFile(stopped,'utf8').catch(()=>undefined)!=='closed') {
      if(Date.now()>deadline) assert.fail('host did not observe owner EOF');
      await new Promise(resolve=>setTimeout(resolve,10));
    }
  } finally { api.disposeCodexConnections(); await rm(root,{recursive:true,force:true}); }
});
