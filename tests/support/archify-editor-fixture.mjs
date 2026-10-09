import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { join, resolve } from 'node:path';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const bundled = await build({entryPoints:['src/infrastructure/vscode/archify-editor.ts'], bundle:true,
  write:false, platform:'node', format:'cjs', target:'node18', external:['vscode'], define:{__AF_RELEASE__:'false'}});

export function fixture(renderer, options = {}) {
  const messages=[], commands=[], registrations=[], saves=new Set(), themes=new Set();
  let received, disposed;
  const uri = path => ({fsPath:path, toString:()=> 'file://'+path});
  const vscode={
    Uri:{joinPath:(root,...parts)=>uri(join(root.fsPath,...parts))}, env:{language:'ko'},
    ViewColumn:{Beside:2}, ExtensionMode:{Development:2},
    window:{registerCustomEditorProvider:(...args)=>{registrations.push(args);return{dispose(){}};},
      onDidChangeActiveColorTheme:fn=>{themes.add(fn);return{dispose:()=>themes.delete(fn)};}},
    workspace:{isTrusted:true,getConfiguration:()=>({get:()=>undefined}),onDidSaveTextDocument:fn=>{saves.add(fn);return{dispose:()=>saves.delete(fn)};}},
    commands:{executeCommand:async(...args)=>commands.push(args)}
  };
  const module={exports:{}};
  runInNewContext(bundled.outputFiles[0].text,{module,exports:module.exports,console,process,Buffer,AbortController,
    require:name=>name==='vscode'?vscode:require(name)});
  const panel={webview:{cspSource:options.cspSource ?? 'https://resources.test',options:{},
    asWebviewUri:value=>({toString:()=> options.resource ? options.resource(value) : 'https://resources.test'+value.fsPath}),
    onDidReceiveMessage:fn=>{received=fn;return{dispose(){received=undefined;}};},
    async postMessage(message){messages.push(message);await options.postMessage?.(message);return true;}},
    onDidDispose:fn=>{disposed=fn;return{dispose(){}};}};
  const provider=new module.exports.ArchifyEditor(uri(resolve('.')),renderer);
  return {provider,panel,messages,commands,registrations,vscode,uri,exports:module.exports,
    send:data=>received(data),save:document=>{for(const fn of saves)fn(document);},
    dispose:()=>disposed(), listenerCount:()=>saves.size+themes.size};
}

export async function waitFor(fn) {
  const end=Date.now()+15_000;
  while(!fn()) { if(Date.now()>end)throw new Error('Editor update timed out');await new Promise(resolve=>setImmediate(resolve)); }
}
