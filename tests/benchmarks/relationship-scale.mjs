import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
const built=await build({entryPoints:[new URL('../../src/infrastructure/agent-factory/agent-client.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const {AgentFactoryClient}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const rows=[];
for(const size of [500,1000]) {
 const root=await mkdtemp(join(tmpdir(),'af-scale-')),agents=join(root,'agents');
 try {
  for(let i=0;i<size;i++) {const run='run-'+String(i).padStart(4,'0'),dir=join(agents,'main-one','runs',run,'children');await mkdir(dir,{recursive:true});await writeFile(join(dir,'child.json'),JSON.stringify({parentAgentId:'main-one',parentRunId:run,agentId:'work-'+i,runId:'child-original'}));}
  for(const enabled of [false,true]) {
   const client=new AgentFactoryClient('/unused',root);client.location=async()=>({agentsRoot:agents});
   if(!enabled) {client.observedChildRuns.get=()=>undefined;client.observedChildRuns.observe=()=>()=>{};}
   let stateChecks=0;const original=client.cachedRunState.bind(client);client.cachedRunState=async path=>{stateChecks++;return original(path);};
   try {
    const start=performance.now();await client.discoverChildAgents('main-one');const coldMs=performance.now()-start;
    const timings=[];stateChecks=0;
    for(let cycle=0;cycle<10;cycle++) {const begin=performance.now();const refs=await client.discoverChildAgents('main-one');timings.push(performance.now()-begin);assert.equal(refs.size,500);for(let i=size-500;i<size;i++) assert.equal(refs.get('work-'+i)?.runId,'child-original');assert.ok(client.observedChildRuns.entries.size<=128);}
    const warmStateChecks=stateChecks;
    const old=await client.discoverChildAgents('main-one','run-0000');assert.equal(old.get('work-0')?.runId,'child-original');
    // Change an uncached run beyond the admitted 128; the fallback must see it immediately.
    const i=size-300,run='run-'+String(i).padStart(4,'0'),file=join(agents,'main-one','runs',run,'children','child.json');
    await writeFile(file,JSON.stringify({parentAgentId:'main-one',parentRunId:run,agentId:'work-'+i,runId:'child-changed'}));
    assert.equal((await client.discoverChildAgents('main-one')).get('work-'+i)?.runId,'child-changed');
    await writeFile(file,JSON.stringify({parentAgentId:'main-one',parentRunId:run,agentId:'work-'+i,runId:'child-original'}));
    timings.sort((a,b)=>a-b);rows.push({size,selectedRuns:500,enabled,coldMs,warmMedianMs:(timings[4]+timings[5])/2,warmStateChecks,iterations:10,cacheEntries:client.observedChildRuns.entries.size,oldRunLookup:true,uncachedMutation:true});
   } finally {client.observedChildRuns.dispose();assert.equal(client.observedChildRuns.entries.size,0);}
  }
 } finally {await rm(root,{recursive:true,force:true});}
}
await writeFile(process.argv[2],JSON.stringify(rows,null,2),{flag:'wx'});console.log(JSON.stringify(rows));
