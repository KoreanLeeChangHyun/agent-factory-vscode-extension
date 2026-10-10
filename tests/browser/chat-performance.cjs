const assert = require('node:assert/strict');
const fs = require('node:fs');

async function checkChatPerformance(page) {
  const measurements = [];
  await page.evaluate(() => window.postMessage({ type: 'host.initialize', panelId: 'performance', role: 'main', runtimeAvailable: true, botsEnabled: false, botsAvailable: false, companionAvailable: false }, '*'));
  await page.waitForFunction(() => window.performanceChat?.state.panelId === 'performance');
  for (const amount of [200, 20000]) {
    const measurement = await page.evaluate(async amount => {
      const api = window.performanceChat;
      const events = Array.from({length:amount}, (_,i) => ({type:i % 2 ? 'assistant':'user', id:'fixture-'+i, runId:'fixture-run-'+i, phase:'final', text:'Synthetic conversation '+i+' · '+'content '.repeat(12), ...(i === 0 ? {attachments:[{id:'file',kind:'file',name:'fixture.txt',uri:'file:///fixture.txt'}]}:{})}));
      // Replay through the existing delivery path, then drain render/persistence work.
      api.state.timeline = [];
      api.state.agentId = 'performance-main';
      window.dispatchEvent(new MessageEvent('message',{data:{type:'conversation.history',agentId:'performance-main',history:{messages:events}}}));
      await new Promise(resolve => setTimeout(resolve,150));
      const originalFind=Array.prototype.find, originalFilter=Array.prototype.filter;
      let findVisits=0,filterVisits=0;
      Array.prototype.find=function(callback,...args){return originalFind.call(this,this===api.state.timeline? (...values)=>{findVisits++;return callback(...values);}:callback,...args);};
      Array.prototype.filter=function(callback,...args){return originalFilter.call(this,this===api.state.timeline? (...values)=>{filterVisits++;return callback(...values);}:callback,...args);};
      const start=performance.now();
      for(let i=0;i<1000;i++) window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.delta',runId:'stream-run',id:'stream-id',stream:'final',text:'chunk '}}));
      const deltaMs=performance.now()-start;
      const persistStart=performance.now();
      for(let i=0;i<100;i++) api.persistNow();
      const persistMs=performance.now()-persistStart;
      Array.prototype.find=originalFind;Array.prototype.filter=originalFilter;
      await new Promise(resolve=>setTimeout(resolve,100));
      const stream=api.state.timeline.find(item=>item.streaming);
      const result={amount,deltaMs,persistMs,findVisits,filterVisits,total:api.state.timeline.length,visible:api.messageElements.size,streamCharacters:stream.text.length,persisted:window.saved.timeline.length};
      // Completion retains all text and original attachment records.
      window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.assistant',runId:'stream-run',phase:'final',text:stream.text}}));
      await new Promise(resolve=>setTimeout(resolve,100));
      result.completedText=api.state.timeline.at(-1).text.length;
      result.originalAttachment=api.state.timeline[0].attachments[0].uri;
      return result;
    }, amount);
    assert.equal(measurement.total, amount+1);
    assert.ok(measurement.visible<=200);
    assert.equal(measurement.persisted,200);
    assert.equal(measurement.streamCharacters,6000);
    assert.equal(measurement.completedText,6000);
    assert.equal(measurement.originalAttachment,'file:///fixture.txt');
    measurements.push(measurement);
  }
  const fullHistory=await page.evaluate(()=>window.performanceChat.state.timeline);
  const continuous=await page.evaluate(()=>({amount:window.performanceChat.state.timeline.length,visible:window.performanceChat.messageElements.size}));
  await page.evaluate(()=>sessionStorage.setItem('submission-restoration-fixture',JSON.stringify(window.saved)));
  await page.reload();
  await page.waitForFunction(()=>window.performanceChat?.messageElements.size>0);
  const reopened=await page.evaluate(()=>({amount:window.performanceChat.state.timeline.length,visible:window.performanceChat.messageElements.size}));
  // Access the complete original history again using the normal pagination path.
  await page.evaluate(()=>{const api=window.performanceChat;api.state.historyNextBefore='older-fixture';api.renderTimeline();});
  await page.locator('.history-older').click();
  assert.ok(await page.evaluate(()=>window.sentMessages.some(m=>m.type==='history.request'&&m.before==='older-fixture')));
  const restored=await page.evaluate(async history=>{
    const api=window.performanceChat;
    const loadStart=performance.now();
    window.dispatchEvent(new MessageEvent('message',{data:{type:'conversation.history',agentId:api.state.agentId,history:{conversationId:api.state.conversationId,messages:history}}}));
    const restoreMs=performance.now()-loadStart;
    await new Promise(resolve=>setTimeout(resolve,150));
    const amount=api.state.timeline.length;
    const start=performance.now();
    for(let i=0;i<1000;i++)window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.delta',runId:'reopened-stream',id:'stream-id',stream:'final',text:'chunk '}}));
    const deltaMs=performance.now()-start;
    const save=performance.now();for(let i=0;i<100;i++)api.persistNow();const persistMs=performance.now()-save;
    window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.assistant',runId:'reopened-stream',phase:'final',text:'chunk '.repeat(1000)}}));
    await new Promise(resolve=>setTimeout(resolve,100));
    return {amount,restoreMs,deltaMs,persistMs,attachment:api.state.timeline.find(item=>item.id==='fixture-0').attachments[0].uri};
  },fullHistory);
  assert.equal(restored.amount,continuous.amount);assert.equal(restored.attachment,'file:///fixture.txt');
  const hidden=await page.evaluate(async()=>{
    const api=window.performanceChat;
    Object.defineProperty(document,'hidden',{configurable:true,value:true});
    for(let i=0;i<100;i++){
      window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.delta',runId:'hidden-run',id:'hidden-'+i,stream:'commentary',text:'Hidden message '}}));
      window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.delta',runId:'hidden-run',id:'hidden-'+i,stream:'commentary',text:String(i)}}));
      window.dispatchEvent(new MessageEvent('message',{data:{type:'chat.assistant',runId:'hidden-run',phase:'commentary',text:'Hidden message '+i}}));
    }
    const pending=api.pendingPreviews.size;
    delete document.hidden;
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise(resolve=>setTimeout(resolve,100));
    return {pending,afterVisible:api.pendingPreviews.size,preserved:api.state.timeline.filter(item=>item.text?.startsWith('Hidden message ')).length,visible:api.messageElements.size};
  });
  assert.equal(hidden.preserved,100);assert.ok(hidden.visible<=200);
  if(!process.env.CHAT_PERFORMANCE_BASELINE){assert.equal(hidden.pending,0);assert.equal(hidden.afterVisible,0);assert.equal(measurements[1].findVisits,0);assert.equal(measurements[1].filterVisits,0);}
  const artifacts=process.env.CHAT_PERFORMANCE_ARTIFACTS;
  const styles=[];
  for(const [name,theme] of Object.entries({dark:{foreground:'#d4d4d4',background:'#1e1e1e',secondary:'#3a3d41',secondaryForeground:'#ffffff'},light:{foreground:'#333333',background:'#ffffff',secondary:'#e5e5e5',secondaryForeground:'#333333'},contrast:{foreground:'#ffffff',background:'#000000',secondary:'#000000',secondaryForeground:'#ffffff'}})) {
    await page.evaluate(theme=>{const style=document.documentElement.style;for(const [key,value] of Object.entries({'--vscode-foreground':theme.foreground,'--vscode-editor-background':theme.background,'--vscode-button-secondaryBackground':theme.secondary,'--vscode-button-secondaryForeground':theme.secondaryForeground,'--vscode-button-secondaryHoverBackground':theme.secondary,'--vscode-disabledForeground':theme.foreground})){style.setProperty(key,value);}window.performanceChat.state.historyFeedback=undefined;window.performanceChat.state.historyNextBefore='older-fixture';window.performanceChat.renderTimeline();},theme);
    const colors=await page.locator('.history-older').evaluate(el=>{const s=getComputedStyle(el);return {color:s.color,background:s.backgroundColor,opacity:s.opacity};});
    assert.notEqual(colors.color, colors.background);
    assert.notEqual(colors.background, 'rgba(0, 0, 0, 0)');
    await page.locator('.history-older').hover();
    await page.locator('.history-older').focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('.history-older').evaluate(el=>getComputedStyle(el).outlineStyle),'solid');
    if(artifacts) await page.screenshot({path:artifacts+'/chat-history-'+name+'.png'});
    await page.locator('.history-older').click();
    const disabled=await page.locator('.history-older').evaluate(el=>({disabled:el.disabled,opacity:getComputedStyle(el).opacity}));
    assert.equal(disabled.disabled,true);assert.equal(disabled.opacity,'1');
    styles.push({name,...colors,disabled});
  }
  const result={measurements,continuous,reopened,restored,hidden,styles};
  if(process.env.CHAT_PERFORMANCE_REPORT) fs.writeFileSync(process.env.CHAT_PERFORMANCE_REPORT,JSON.stringify(result,null,2)+'\n');
  console.log(JSON.stringify(result));
}
module.exports={checkChatPerformance};
