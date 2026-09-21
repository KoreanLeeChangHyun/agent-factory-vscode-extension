import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {build} from 'esbuild';
let stats=0,bytes=0,parses=0,requests=0;
const originalOpen=fs.open, originalParse=JSON.parse;
fs.open=async(...args)=>{const file=await originalOpen(...args);const read=file.read.bind(file);file.read=async(...args)=>{const result=await read(...args);bytes+=result.bytesRead;return result;};return file;};
JSON.parse=(...args)=>{parses++;return originalParse(...args);};
const original=fs.lstat;
fs.lstat=async(...args)=>{stats++;return original(...args);};syncBuiltinESMExports();
const built=await build({entryPoints:[new URL('../../src/infrastructure/agent-factory/agent-client.ts',import.meta.url).pathname],bundle:true,write:false,platform:'node',format:'esm'});
const {AgentFactoryClient}=await import('data:text/javascript;base64,'+Buffer.from(built.outputFiles[0].text).toString('base64'));
const rows=[];
const iterations=Number(process.env.AF_BENCH_ITERATIONS ?? 10);
assert.ok(Number.isInteger(iterations) && iterations >= 10);
try {for(const size of [500,1000]) {
 const root=await fs.mkdtemp(join(tmpdir(),'af-child-scale-')),agents=join(root,'agents');
 const client=new AgentFactoryClient('/unused',root);client.location=async()=>({agentsRoot:agents});
 const put=async(path,value)=>fs.writeFile(path,JSON.stringify(value));
 try {
  for(let i=0;i<size;i++) {
   const run='run-'+String(i).padStart(4,'0'),parent=join(agents,'main-one','runs',run),child=join(agents,'work-'+i);
   await fs.mkdir(join(parent,'children'),{recursive:true});await fs.mkdir(join(child,'runs','child-original'),{recursive:true});
   await put(join(parent,'children','child.json'),{parentAgentId:'main-one',parentRunId:run,agentId:'work-'+i,runId:'child-original'});
   await put(join(parent,'state.json'),{taskMode:'direct'});await put(join(child,'session.json'),{agentId:'work-'+i,role:'work'});
   await put(join(child,'runs','child-original','state.json'),{status:'running'});
  }
  const cachedRead=client.cachedRunState.bind(client);client.cachedRunState=async(...args)=>{requests++;return cachedRead(...args);};
  const read=()=>client.listChildSessions('main-one');assert.equal((await read()).length,500);
  bytes=0;parses=0;requests=0;
  const timings=[],checks=[],cpuStart=process.cpuUsage();
  for(let n=0;n<iterations;n++){stats=0;const start=performance.now();const result=await read();timings.push(performance.now()-start);checks.push(stats);assert.equal(result.length,500);assert.ok(result.every(x=>x.status==='running'));}
  const cpu=process.cpuUsage(cpuStart);const cacheMetrics={readBytes:bytes,jsonParses:parses,stateRequests:requests,hitRatio:1-parses/requests,cacheEntries:client.runStateSnapshots.size};
  assert.equal(bytes,0,'unchanged warmed state files must not be read again');
  assert.equal(parses,0,'unchanged warmed state files must not be parsed again');
  const i=size-300,run='run-'+String(i).padStart(4,'0'),parent=join(agents,'main-one','runs',run,'children');
  await fs.mkdir(join(agents,'work-new','runs','child-new'),{recursive:true});
  await put(join(agents,'work-new','session.json'),{agentId:'work-new',role:'work'});await put(join(agents,'work-new','runs','child-new','state.json'),{status:'running'});
  await put(join(parent,'new.json'),{parentAgentId:'main-one',parentRunId:run,agentId:'work-new',runId:'child-new'});
  let start=performance.now();assert.ok((await read()).some(x=>x.agentId==='work-new'));const discoveryMs=performance.now()-start;
  const state=join(agents,'work-'+i,'runs','child-original','state.json');await put(state,{status:'completed'});
  start=performance.now();assert.equal((await read()).find(x=>x.agentId==='work-'+i).status,'completed');const completionMs=performance.now()-start;
  await put(state+'.tmp',{status:'failed'});await fs.rename(state+'.tmp',state);assert.equal((await read()).find(x=>x.agentId==='work-'+i).status,'failed');
  assert.equal((await client.listChildSessions('main-one','run-0000')).length,1);
  timings.sort((a,b)=>a-b);rows.push({size,cacheMetrics,selected:500,iterations,medianMs:(timings[Math.floor((iterations-1)/2)]+timings[Math.floor(iterations/2)])/2,lstatCalls:checks,cpuMs:(cpu.user+cpu.system)/1000,discoveryMs,completionMs,atomicReplacement:true,explicitOldRun:true});
 } finally {client.observedChildRuns.dispose();await fs.rm(root,{recursive:true,force:true});}
}} finally {fs.lstat=original;fs.open=originalOpen;JSON.parse=originalParse;syncBuiltinESMExports();}
await fs.writeFile(process.argv[2],JSON.stringify(rows,null,2),{flag:'wx'});console.log(JSON.stringify(rows));
