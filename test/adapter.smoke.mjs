import assert from 'node:assert/strict';
import {Effect} from 'effect';
import {fixture} from './support/chrome.mjs';
import {mcpClient} from './support/mcp-client.mjs';
import {Cdp,checkpoint} from '../dist/cdp.js';
import {createRun,atomic} from '../dist/journal.js';
import {attachPage,pageJob,checkOne,pollChecks} from '../dist/page-worker.js';
import {legacyExpression} from '../dist/dom.js';
import {screenshotRun} from '../dist/workflows.js';
import path from 'node:path';
const f=await fixture(), raw=await Cdp.open(f.session);let connected,other;
const checks=[];
try {
 const {targetId}=await raw.send('Target.createTarget',{url:'about:blank'});
 const {targetId:otherId}=await raw.send('Target.createTarget',{url:'about:blank'});
 connected=await attachPage(f.session,targetId);other=await attachPage(f.session,otherId);
 await connected.page.setContent(`<h1>Ready</h1><input id="name"><span id="hidden" hidden>Hidden</span><input id="secret" type="password" value="not-for-logs"><div id="open"></div><div id="closed"></div><iframe id="frame"></iframe><script>document.querySelector('#open').attachShadow({mode:'open'}).innerHTML='<input id="inside"><output id="answer">Open root</output>';document.querySelector('#closed').attachShadow({mode:'closed'}).innerHTML='<button>Closed root button</button>';</script>`);
 await other.page.setContent('<h1>Other</h1><input id="name" value="Untouched">');
 const frame=await connected.page.locator('#frame').contentFrame();await frame.locator('body').evaluate(e=>{e.innerHTML='<input id="insideFrame"><iframe id="nested" srcdoc="<input id=deep>"></iframe>'});
 const task={url:f.url,goal:'Fill scoped controls',steps:[{kind:'fill',selector:'#name',value:'Root',safeToRepeat:true},{kind:'fill',selector:'#inside',shadow:'open',value:'Shadow',safeToRepeat:true},{kind:'fill',frames:['#frame'],selector:'#insideFrame',value:'Frame',safeToRepeat:true},{kind:'fill',frames:['#frame','#nested'],selector:'#deep',value:'Nested',safeToRepeat:true}]};
 const {journal}=createRun(f.directory,task,false,f.profile);journal.append('target',{targetId,browserId:f.session.browserId});atomic(path.join(f.directory,'targets',f.session.namespace,`${targetId}.json`),{targetId,browserId:f.session.browserId});
 const sid=await raw.attach(targetId);journal.append('checkpoint',await checkpoint(raw,sid));
 await pageJob({root:f.directory,runId:journal.runId,session:f.session,targetId,operation:'steps',steps:task.steps,timeoutMs:20000},new AbortController().signal);
 assert.equal(await connected.page.locator('#name').inputValue(),'Root');assert.equal(await other.page.locator('#name').inputValue(),'Untouched');checks.push('exact-target attachment and disconnect without closing Chrome');
 for(const c of [{kind:'value',selector:'#inside',shadow:'open',value:'Shadow'},{kind:'value',frames:['#frame'],selector:'#insideFrame',value:'Frame'},{kind:'value',frames:['#frame','#nested'],selector:'#deep',value:'Nested'}])assert.equal((await checkOne(connected.page,c)).passed,true);
 checks.push('open shadow and nested-frame controls plus assertions');
 await assert.rejects(()=>checkOne(connected.page,{kind:'count',shadow:'closed',selector:'button',value:'0'}),/Closed shadow/);
 await assert.rejects(()=>checkOne(connected.page,{kind:'count',frames:['#missing'],selector:'button',value:'0'}),/frame path/);
 assert.equal((await checkOne(connected.page,{kind:'text',selector:'#hidden',value:'<not visible>'})).passed,false);
 assert.equal((await raw.evaluate(sid,legacyExpression([{kind:'text',selector:'#missing',value:'matching elements'}])))[0].passed,false);checks.push('unsupported scopes and diagnostic sentinels cannot pass');
 // Missing elements are not visible; missing scopes and ambiguous matches remain unknown.
 for(const scope of [{},{frames:['#frame']},{frames:['#frame','#nested']},{shadow:'open'}]) for(const value of ['false','true']) {
  const c={kind:'visible',selector:'#absent',value,...scope}, result=await checkOne(connected.page,c);
  assert.equal(result.actual,'false');assert.equal(result.passed,value==='false');
  if(!scope.frames && !scope.shadow)assert.deepEqual(result,(await raw.evaluate(sid,legacyExpression([c])))[0]);
 }
 assert.equal((await checkOne(connected.page,{kind:'visible',selector:'#hidden',value:'false'})).passed,true);
 for(const value of ['false','true'])assert.equal((await checkOne(connected.page,{kind:'visible',selector:'h1, #name',value})).passed,false);
 for(const kind of ['text','value','checked'])assert.equal((await checkOne(connected.page,{kind,selector:'#absent',value:'<0 matching elements>'})).passed,false);
 assert.equal((await checkOne(connected.page,{kind:'count',selector:'#absent',value:'0'})).passed,true);
 await assert.rejects(()=>checkOne(connected.page,{kind:'visible',frames:['#missing'],selector:'button',value:'false'}),/frame path/);
 await assert.rejects(()=>checkOne(connected.page,{kind:'visible',shadow:'closed',selector:'button',value:'false'}),/Closed shadow/);
 await connected.page.evaluate(()=>{const e=document.createElement('span');e.id='transient';e.textContent='Busy';document.body.append(e)});
 const disappears={kind:'visible',selector:'#transient',value:'false'};
 assert.equal((await checkOne(connected.page,disappears)).passed,false);
 const waiting=pollChecks(connected.page,[disappears],3000);await connected.page.locator('#transient').evaluate(e=>e.remove());
 assert.equal((await waiting)[0].passed,true);checks.push('negative visibility, legacy parity, and disappearance polling');
 const extracted=await pageJob({root:f.directory,runId:journal.runId,session:f.session,targetId,operation:'extract',extract:[{name:'good',kind:'value',selector:'#inside',shadow:'open'},{name:'missing',kind:'value',selector:'#absent'}],timeoutMs:10000},new AbortController().signal);assert.equal(extracted.fields.good.value,'Shadow');assert.ok(extracted.fields.missing.error);assert.equal(extracted.complete,false);checks.push('partial extraction preserves valid fields');
 const first=await Effect.runPromise(screenshotRun({runId:journal.runId}));assert.ok(first.width<=1800);assert.equal(first.scale.x,first.width/first.css.width);
 await raw.send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:2,mobile:false},sid);
 const retina=await Effect.runPromise(screenshotRun({runId:journal.runId}));assert.ok(retina.width<=1800 && retina.height<=1800);assert.equal(retina.devicePixelRatio,2);checks.push('DPR-aware bounded screenshots');
 const client=await mcpClient();try{const result=await client.request('tools/call',{name:'browser_screenshot',arguments:{runId:journal.runId}});assert.notEqual(result.result?.isError,true,JSON.stringify(result));const image=result.result.content.find(c=>c.type==='image');assert.equal(image.mimeType,'image/png');assert.equal(Buffer.from(image.data,'base64').subarray(1,4).toString(),'PNG');assert.ok(!('path' in result.result.structuredContent));}finally{await client.close()}checks.push('native MCP image delivery without server-local paths');
 console.log(JSON.stringify({suite:'scoped adapter',passed:checks,paidModelCalls:0}));
}finally{await connected?.browser.close();await other?.browser.close();await raw.close();await f.cleanup()}
