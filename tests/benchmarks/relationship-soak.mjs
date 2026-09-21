// Disposable fixtures only. Wall-clock notifications and expiry are exercised together.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { performance } from 'node:perf_hooks';
import { build } from 'esbuild';
const seconds=Number(process.argv[2]||900),output=process.argv[3];
assert.ok(Number.isInteger(seconds)&&seconds>=10&&seconds<=86400&&output);
const compiled=await build({entryPoints:[new URL('../../src/infrastructure/agent-factory/agent-client.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const {AgentFactoryClient}=await import('data:text/javascript;base64,'+Buffer.from(compiled.outputFiles[0].text).toString('base64'));
const root=await mkdtemp(join(tmpdir(),'af-relationship-soak-'));const agents=join(root,'agents');
const client=new AgentFactoryClient('/unused',root);client.location=async()=>({agentsRoot:agents});
const expected=new Map(), samples=[];let queries=0,changes=0;const started=performance.now();
try {
 for(let i=0;i<100;i++) {
  const dir=join(agents,'main-one','runs','run-'+String(i).padStart(3,'0'),'children');await mkdir(dir,{recursive:true});
  const value={agentId:'work-'+i,runId:'child-0',parentAgentId:'main-one',parentRunId:'run-'+String(i).padStart(3,'0')};
  await writeFile(join(dir,'child.json'),JSON.stringify(value));expected.set(value.agentId,value.runId);
 }
 for(let iteration=0;performance.now()-started<seconds*1000;iteration++) {
  if(iteration%5===0) {
   const i=changes%100, dir=join(agents,'main-one','runs','run-'+String(i).padStart(3,'0'),'children'),file=join(dir,'child.json');
   const value={agentId:'work-'+i,runId:'child-'+(changes+1),parentAgentId:'main-one',parentRunId:'run-'+String(i).padStart(3,'0')};
   if(changes%3===0) {await writeFile(join(dir,'replacement'),JSON.stringify(value));await rename(join(dir,'replacement'),file);}
   else if(changes%3===1) {await rm(file);await writeFile(file,JSON.stringify(value));}
   else await writeFile(file,JSON.stringify(value));
   expected.set(value.agentId,value.runId);changes++;
  }
  const begin=performance.now();let observed;
  // Event delivery is asynchronous; require convergence within one second.
  do {
   observed=await client.discoverChildAgents('main-one');queries++;
   if([...expected].every(([id,run])=>observed.get(id)?.runId===run)&&observed.size===expected.size) break;
   await new Promise(r=>setTimeout(r,5));
  } while(performance.now()-begin<1000);
  assert.equal(observed.size,expected.size);
  for(const [id,run] of expected) assert.equal(observed.get(id)?.runId,run);
  assert.ok(client.observedChildRuns.entries.size<=128);
  if(iteration%10===0) {
   global.gc?.();const memory=process.memoryUsage();
   samples.push({elapsedSeconds:(performance.now()-started)/1000,heap:memory.heapUsed,rss:memory.rss,fd:(await readdir('/proc/self/fd')).length,cacheEntries:client.observedChildRuns.entries.size,queryMs:performance.now()-begin});
  }
  if(iteration%30===0) console.log(JSON.stringify({elapsedSeconds:Math.round((performance.now()-started)/1000),queries,changes}));
  await new Promise(r=>setTimeout(r,1000));
 }
 client.observedChildRuns.dispose();await new Promise(r=>setTimeout(r,20));global.gc?.();
 const result={ok:true,durationSeconds:(performance.now()-started)/1000,queries,changes,runs:100,samples,finalMemory:process.memoryUsage(),finalFd:(await readdir('/proc/self/fd')).length,finalCacheEntries:client.observedChildRuns.entries.size,gcAvailable:Boolean(global.gc)};
 await writeFile(output,JSON.stringify(result,null,2),{flag:'wx'});console.log(JSON.stringify({ok:true,queries,changes}));
} finally {client.observedChildRuns.dispose();await rm(root,{recursive:true,force:true});}
