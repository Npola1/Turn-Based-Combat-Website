/**
 * All RPG regression tests live in this file. Run `npm test` or
 * `node scripts/test-game.mjs`. --suite selects one section; --list lists them.
 * Each section runs in a separate worker process so mocks, browser globals,
 * node:test registrations and exit codes cannot leak into another section.
 */
import { spawn as spawnWorker } from 'node:child_process';
import { createServer as reserveServer } from 'node:net';
import { mkdir as makeDirectory, mkdtemp as makeTemporaryDirectory, readFile as readResult, writeFile as writeResult, rm as removeTemporaryDirectory } from 'node:fs/promises';
import { tmpdir as temporaryRoot } from 'node:os';
import { resolve as absolutePath, relative as relativePath } from 'node:path';
import { fileURLToPath as modulePath } from 'node:url';

const TEST_FILE=modulePath(import.meta.url);
const PROJECT_ROOT=absolutePath(modulePath(new URL('..',import.meta.url)));
const SUITES=[
  {id:'database',name:'Aurora DSQL-compatible SQL storage and Lambda API',run:testDatabase,unit:true},
  {id:'browser-selection',name:'System default browser selection',run:testBrowserSelection,unit:true},
  {id:'skills',name:'Every skill, passive, Mimic and enemy action',run:testSkills,report:'skills.json',html:'skills-report.html',env:'RPG_SKILL_REPORT_DIR'},
  {id:'attacks',name:'Attack calculations and overwritten stats',run:testAttacks,folder:'attacks',report:'attacks.json',html:'attacks-report.html',env:'RPG_ATTACK_REPORT_DIR'},
  {id:'phases',name:'Battle phases, dialogue and turn flow',run:testPhases,folder:'phases',report:'phases.json',html:'phases-report.html',env:'RPG_PHASE_REPORT_DIR'},
  {id:'browser',name:'Real browser save/load and combat history',run:testSaveFlow,server:true},
  {id:'extended',name:'Items, party combinations, follow-ups, probability and stress',run:testExpandedMechanics,report:'extended.json',html:'extended.html',env:'RPG_EXPANDED_REPORT_DIR'},
  {id:'api',name:'HTTP validation, concurrent saves and server restart',run:testApiResilience,report:'api.json',html:'api.html',env:'RPG_EXPANDED_REPORT_DIR'},
  {id:'transport',name:'Save failures, retries, pending writes and refresh',run:testSaveTransport,server:true,report:'transport.json',html:'transport.html',env:'RPG_EXPANDED_REPORT_DIR'},
  {id:'journeys',name:'Complete battles, UI, accessibility, responsive layout and long sessions',run:testJourneysAndUi,server:true,report:'journeys.json',html:'journeys.html',env:'RPG_EXPANDED_REPORT_DIR'},
  {id:'matrix',name:'Explicit additional-browser matrix',run:testBrowserMatrix,report:'matrix.json',html:'matrix.html',env:'RPG_EXPANDED_REPORT_DIR'},
  {id:'init',name:'Initialization, music, SFX, images and visuals',run:testInitialization,folder:'initialization',report:'initialization.json',html:'initialization-report.html',env:'RPG_INIT_REPORT_DIR'}
];
const ownedChildren=new Set();
const waitFor=ms=>new Promise(done=>setTimeout(done,ms));
let interrupted=false;
function stopOwned(child){
  if(!child?.pid)return;
  try{if(process.platform==='win32')child.kill('SIGTERM');else process.kill(-child.pid,'SIGTERM');}catch{}
}
function startOwned(args,options={}){
  const child=spawnWorker(process.execPath,args,{cwd:PROJECT_ROOT,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],...options});
  ownedChildren.add(child);return child;
}
async function releaseOwned(child){
  stopOwned(child);
  if(child.exitCode===null&&child.signalCode===null)await Promise.race([new Promise(done=>child.once('close',done)),waitFor(2000)]);
  // Workers may have exited before a descendant. Target only this owned group.
  stopOwned(child);ownedChildren.delete(child);
}
async function startSaveServer(temporary){
  const reserve=reserveServer();await new Promise((done,failed)=>{reserve.once('error',failed);reserve.listen(0,'127.0.0.1',done);});
  const port=reserve.address().port;await new Promise(done=>reserve.close(done));
  const url=`http://127.0.0.1:${port}`;
  const child=startOwned([absolutePath(PROJECT_ROOT,'server/server.js')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),RPG_LOCAL_DB:absolutePath(temporary,'save-flow-postgres'),RPG_DSQL_HOST:'',DATABASE_URL:''}});
  let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;});
  let startError;child.on('error',error=>{startError=error;});
  const deadline=Date.now()+10000;
  while(Date.now()<deadline&&!interrupted){
    if(startError)throw startError;
    if(child.exitCode!==null||child.signalCode!==null)throw Error('Temporary save server exited: '+output);
    try{const response=await fetch(url+'/api/saves',{signal:AbortSignal.timeout(300)});if(response.ok)return {child,url};}catch{}
    await waitFor(50);
  }
  throw Error('Temporary save server failed to start: '+output);
}
async function runSection(suite,reportRoot,temporary){
  const started=Date.now(),folder=reportRoot;await makeDirectory(folder,{recursive:true});
  const env={...process.env};if(suite.env)env[suite.env]=folder;
  let server,child,output='',timer,timedOut=false;
  try{
    if(suite.server){server=await startSaveServer(temporary);env.RPG_TEST_URL=server.url;env.RPG_SCREENSHOT=absolutePath(reportRoot,'save-picker.png');}
    child=startOwned([TEST_FILE,'--worker',suite.id],{env});
    for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output+=chunk;process.stdout.write(chunk);});
    const budget=Number(process.env.RPG_SUITE_TIMEOUT_MS||1200000);
    timer=setTimeout(()=>{timedOut=true;stopOwned(child);},budget);
    const exit=await new Promise((done,failed)=>{child.once('error',failed);child.once('close',(code,signal)=>done({code,signal}));});
    let report,reportError;
    if(suite.report){try{report=JSON.parse(await readResult(absolutePath(folder,suite.report),'utf8'));}catch(error){reportError='Suite report missing or invalid: '+error.message;}}
    const checks=report?.results||report?.checks;
    const passMatch=output.match(/(?:#|ℹ) pass (\d+)/),failMatch=output.match(/(?:#|ℹ) fail (\d+)/);
    const passed=checks?checks.filter(c=>c.passed&&!c.skipped).length:Number(passMatch?.[1]||(exit.code===0?1:0));
    const failed=checks?checks.filter(c=>!c.passed&&!c.skipped).length:Number(failMatch?.[1]||(exit.code!==0?1:0));
    const complete=exit.code===0&&!timedOut&&!reportError&&failed===0;
    return {id:suite.id,name:suite.name,passed,failed,skipped:checks?checks.filter(c=>c.skipped).length:Number(output.match(/(?:#|ℹ) skipped (\d+)/)?.[1]||0),ok:complete,exitCode:exit.code,signal:exit.signal,ms:Date.now()-started,timedOut,error:reportError,report:suite.html&&report?relativePath(reportRoot,absolutePath(folder,suite.html)).split('\\').join('/'):null,checks:checks||[],output};
  }catch(error){return {id:suite.id,name:suite.name,ok:false,passed:0,failed:1,ms:Date.now()-started,error:String(error),output};}
  finally{clearTimeout(timer);if(child)await releaseOwned(child);if(server)await releaseOwned(server.child);}
}
// Self-contained report: original artifacts retain their exact bytes and can be
// viewed or downloaded offline. Worker reports only exist in temporary folders.
const SINGLE_REPORT='all-tests-report.html';
const REPORT_PAYLOAD_ID='rpg-report-payload';
const artifactMime=path=>({'.html':'text/html','.json':'application/json','.log':'text/plain','.txt':'text/plain','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.svg':'image/svg+xml','.webp':'image/webp'})[/\.[^.]+$/.exec(path)?.[0]?.toLowerCase()]||'application/octet-stream';
async function artifactRecord(path,bytes){
  const {createHash}=await import('node:crypto');
  return {path,mime:artifactMime(path),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),base64:bytes.toString('base64')};
}
async function collectReportArtifacts(root,prefix=''){
  const {readdir}=await import('node:fs/promises');const records=[];
  for(const entry of await readdir(root,{withFileTypes:true})){
    const path=absolutePath(root,entry.name),label=prefix+entry.name;
    if(entry.isDirectory())records.push(...await collectReportArtifacts(path,label+'/'));
    else if(entry.isFile())records.push(await artifactRecord(label,await readResult(path)));
    else throw Error('Report folder contains an unsupported entry: '+path);
  }
  return records;
}
function parseReportPayload(html){
  const match=html.match(/<script type="application\/json" id="rpg-report-payload">([\s\S]*?)<\/script>/);
  return match?JSON.parse(match[1]):null;
}
async function saveSingleReport(root,report,files){
  const payload={version:1,bundledAt:new Date().toISOString(),report,files};
  const html=renderSingleReport(payload),target=absolutePath(root,SINGLE_REPORT),temp=target+'.tmp';
  // Verify all embedded files before publishing or deleting any separate artifact.
  const parsed=parseReportPayload(html);
  if(!parsed||parsed.files.length!==files.length)throw Error('Embedded report verification failed');
  for(const file of parsed.files){const record=await artifactRecord(file.path,Buffer.from(file.base64,'base64'));if(record.sha256!==file.sha256||record.bytes!==file.bytes)throw Error('Artifact changed while embedding: '+file.path);}
  await writeResult(temp,html);const {rename}=await import('node:fs/promises');await rename(temp,target);
  return report;
}
async function writeCombined(root,rows,artifacts){
  const report={generatedAt:new Date().toISOString(),completed:rows.length,totalSuites:SUITES.length,passed:rows.reduce((n,r)=>n+r.passed,0),failed:rows.reduce((n,r)=>n+r.failed,0),failedSuites:rows.filter(r=>!r.ok).length,skipped:rows.reduce((n,r)=>n+(r.skipped||0),0),suites:rows};
  const files=new Map(artifacts.map(file=>[file.path,file]));
  files.set('all-tests.json',await artifactRecord('all-tests.json',Buffer.from(JSON.stringify(report,null,2)+'\n')));
  for(const row of rows)files.set(row.id+'.log',await artifactRecord(row.id+'.log',Buffer.from(row.output||row.error||'')));
  return saveSingleReport(root,report,[...files.values()]);
}
async function mergeExistingReports(root){
  const existing=await collectReportArtifacts(root);const combined=existing.find(f=>f.path===SINGLE_REPORT);
  const previous=combined?parseReportPayload(Buffer.from(combined.base64,'base64').toString('utf8')):null;
  const files=new Map((previous?.files||[]).map(f=>[f.path,f]));
  for(const file of existing){if(previous&&file.path===SINGLE_REPORT)continue;files.set(file.path,file);}
  const raw=files.get('all-tests.json');const report=raw?JSON.parse(Buffer.from(raw.base64,'base64').toString('utf8')):previous?.report;
  if(!report?.suites)throw Error('No combined test results found to merge. Run npm test first.');
  await saveSingleReport(root,report,[...files.values()]);
  // Re-read the committed file before removing the now-embedded originals.
  const verified=parseReportPayload(await readResult(absolutePath(root,SINGLE_REPORT),'utf8'));
  if(verified.files.length!==files.size)throw Error('Saved report verification failed; originals retained');
  const {readdir}=await import('node:fs/promises');
  for(const entry of await readdir(root))if(entry!==SINGLE_REPORT)await removeTemporaryDirectory(absolutePath(root,entry),{recursive:true,force:true});
  console.log(`Merged ${files.size} original files into ${absolutePath(root,SINGLE_REPORT)}. Original bytes verified; separate files removed.`);
}
function reportClient(){
  'use strict';
  const payload=JSON.parse(document.getElementById('rpg-report-payload').textContent),report=payload.report;
  const files=new Map(payload.files.map(file=>[file.path,file]));
  const $=id=>document.getElementById(id);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeId=value=>'suite-'+encodeURIComponent(value);
  const dataUrl=file=>`data:${file.mime};base64,${file.base64}`;
  function download(file){const bytes=Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:file.mime}));const a=document.createElement('a');a.href=url;a.download=file.path.split('/').at(-1);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  $('totals').textContent=`${report.passed} passed · ${report.failed} failed · ${report.failedSuites} failing suites · ${report.skipped||0} pending/skipped`;
  $('timestamp').textContent=`Test results: ${report.generatedAt} · ${report.completed}/${report.totalSuites} suites completed · ${payload.files.length} embedded files`;
  $('suite-links').innerHTML=report.suites.map(s=>`<a href="#${safeId(s.id)}">${escape(s.name)} <span class="${s.ok?'pass':'fail'}">${s.passed}/${s.failed}</span></a>`).join('');
  const searchable=[];const groupNames=new Set();
  for(const suite of report.suites){
    const section=document.createElement('section');section.id=safeId(suite.id);section.className='suite';
    section.innerHTML=`<h2>${escape(suite.name)}</h2><p class="${suite.ok?'pass':'fail'}">${suite.passed} passed · ${suite.failed} failed · ${suite.skipped||0} pending/skipped${suite.timedOut?' · timed out':''}</p>${suite.error?`<pre class="fail">${escape(suite.error)}</pre>`:''}<div class="suite-tools"><button data-original>View original report</button><button data-log>View full log</button></div><div class="checks"></div>`;
    section.querySelector('[data-original]').onclick=()=>openFile(suite.report||suite.id+'.log');
    section.querySelector('[data-log]').onclick=()=>openFile(suite.id+'.log');
    const nodeChecks=suite.unit||['database','browser-selection'].includes(suite.id)?(suite.output||'').split('\n').filter(line=>/^[✔✖﹣] /.test(line)).map(line=>({name:line.slice(2).replace(/ \([^)]*ms\)$/,''),group:suite.id,passed:line.startsWith('✔'),skipped:line.startsWith('﹣')})):[];
    const checks=suite.checks?.length?suite.checks:nodeChecks.length?nodeChecks:[{name:'Complete integration scenario',group:suite.id,passed:suite.ok,evidence:suite.output,error:suite.error}];
    for(const check of checks){
      const group=check.group||check.character||suite.id,name=check.name||[check.skill,check.scenario].filter(Boolean).join(' / ');
      groupNames.add(group);
      const details=document.createElement('details');details.className='check';
      details.innerHTML=`<summary class="${check.skipped?'muted':check.passed?'pass':'fail'}"><span>${check.skipped?'SKIP':check.passed?'PASS':'FAIL'}</span> ${escape(group)} / ${escape(name)}</summary><div class="evidence"></div>`;
      details.addEventListener('toggle',()=>{if(details.open&&!details.dataset.loaded){details.querySelector('.evidence').innerHTML=`${check.error?`<pre class="fail">${escape(check.error)}</pre>`:''}${check.assertions?.length?`<table><thead><tr><th>Check</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${check.assertions.map(a=>`<tr><td>${escape(a.label)}</td><td>${escape(typeof a.expected==='object'?JSON.stringify(a.expected):a.expected)}</td><td>${escape(typeof a.actual==='object'?JSON.stringify(a.actual):a.actual)}</td></tr>`).join('')}</tbody></table>`:''}<details><summary>Complete evidence / raw result</summary><pre>${escape(JSON.stringify(check,null,2))}</pre></details>`;details.dataset.loaded='1';}});
      section.querySelector('.checks').appendChild(details);
      searchable.push({details,section,passed:check.passed,skipped:check.skipped,group,search:(suite.name+' '+JSON.stringify(check)).toLowerCase()});
    }
    $('suites').appendChild(section);
  }
  $('group').innerHTML='<option value="">All groups</option>'+[...groupNames].sort().map(g=>`<option>${escape(g)}</option>`).join('');
  function filter(){const query=$('search').value.toLowerCase().trim(),failed=$('failures').checked,group=$('group').value;let visible=0;const shown=new Set();for(const row of searchable){const match=(!failed||(!row.passed&&!row.skipped))&&(!group||group===row.group)&&(!query||row.search.includes(query));row.details.hidden=!match;if(match){visible++;shown.add(row.section);}}for(const s of document.querySelectorAll('.suite'))s.hidden=!shown.has(s);$('matching').textContent=`${visible} matching checks`;}
  $('search').addEventListener('input',filter);$('failures').onchange=filter;$('group').onchange=filter;
  $('clear').onclick=()=>{$('search').value='';$('failures').checked=false;$('group').value='';filter();};
  $('open-visible').onclick=()=>{for(const row of searchable)if(!row.details.hidden)row.details.open=true;};
  $('close-all').onclick=()=>{for(const row of searchable)row.details.open=false;};
  $('only-failures').onclick=()=>{$('failures').checked=true;$('group').value='';$('search').value='';filter();$('suites').scrollIntoView();};
  $('suite-links').addEventListener('click',event=>{const a=event.target.closest('a');if(!a)return;$('clear').click();});
  function gallery(){const images=payload.files.filter(f=>f.mime.startsWith('image/'));$('gallery').innerHTML=images.map(f=>`<button class="shot" data-image="${escape(f.path)}"><img loading="lazy" src="${dataUrl(f)}" alt="${escape(f.path)}"><span>${escape(f.path)}</span></button>`).join('');}
  function showImage(file){$('image-title').textContent=file.path;$('large-image').src=dataUrl(file);$('image-download').onclick=()=>download(file);if(!$('image-dialog').open)$('image-dialog').showModal();}
  $('gallery').onclick=event=>{const button=event.target.closest('[data-image]');if(button)showImage(files.get(button.dataset.image));};
  $('image-close').onclick=()=>$('image-dialog').close();
  let currentFile;let viewerFrame;
  function openFile(path){const file=files.get(path);if(!file){$('file-status').textContent='Embedded file not found: '+path;return;}
    currentFile=file;$('file-select').value=path;$('file-status').textContent=`${file.path} · ${file.bytes.toLocaleString()} bytes · SHA-256 ${file.sha256}`;
    const host=$('file-preview');host.replaceChildren();viewerFrame=null;
    if(file.mime==='text/html'){
      const decoded=new TextDecoder().decode(Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)));
      let html=decoded.replace(/\b(src|href)=(['"])(.*?)\2/gi,(all,attr,quote,value)=>{
        if(/^(data:|https?:|#|mailto:|javascript:)/i.test(value))return all;
        let path;try{path=decodeURIComponent(new URL(value,'https://report.invalid/'+file.path).pathname.slice(1));}catch{return all;}
        const target=files.get(path);if(!target)return all;
        return attr.toLowerCase()==='src'?`${attr}=${quote}${dataUrl(target)}${quote}`:`href="#" data-report-file="${escape(path)}"`;
      });
      const bridge="<script>document.addEventListener('click',function(e){const a=e.target.closest('a[data-report-file]');if(a){e.preventDefault();parent.postMessage({kind:'rpg-report-open',path:a.dataset.reportFile},'*');}});<"+"/script>";
      html+=bridge;
      const frame=document.createElement('iframe');frame.title='Original report: '+file.path;frame.setAttribute('sandbox','allow-scripts allow-downloads');frame.srcdoc=html;host.appendChild(frame);viewerFrame=frame;
    }else if(file.mime.startsWith('image/')){const image=document.createElement('img');image.src=dataUrl(file);image.alt=file.path;image.className='original-image';host.appendChild(image);}
    else{const pre=document.createElement('pre');pre.textContent=new TextDecoder().decode(Uint8Array.from(atob(file.base64),c=>c.charCodeAt(0)));host.appendChild(pre);}
    $('original-files').scrollIntoView();
  }
  window.addEventListener('message',event=>{if(viewerFrame&&event.source===viewerFrame.contentWindow&&event.data?.kind==='rpg-report-open'&&files.has(event.data.path))openFile(event.data.path);});
  function fileOptions(){const query=$('file-search').value.toLowerCase();$('file-select').innerHTML='<option value="">Choose an original file…</option>'+payload.files.filter(f=>f.path.toLowerCase().includes(query)).sort((a,b)=>a.path.localeCompare(b.path)).map(f=>`<option value="${escape(f.path)}">${escape(f.path)} (${f.bytes.toLocaleString()} bytes)</option>`).join('');}
  $('file-search').oninput=fileOptions;$('file-select').onchange=()=>{if($('file-select').value)openFile($('file-select').value);};
  $('download-file').onclick=()=>{if(currentFile)download(currentFile);};
  $('download-json').onclick=()=>{const text=JSON.stringify(report,null,2)+'\n';const bytes=new TextEncoder().encode(text);let binary='';for(const b of bytes)binary+=String.fromCharCode(b);download({path:'all-tests.json',mime:'application/json',base64:btoa(binary)});};
  $('export-originals').onclick=()=>{const manifest=JSON.stringify({format:'rpg-report-artifacts-v1',files:payload.files},null,2);const url=URL.createObjectURL(new Blob([manifest],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='test-results-originals.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
  gallery();fileOptions();filter();
  window.__rpgReportReady={files:payload.files.length,checks:searchable.length,suites:report.suites.length};
}
function renderSingleReport(payload){
  const json=JSON.stringify(payload).replace(/</g,'\\u003c').replace(/\u2028/g,'\\u2028').replace(/\u2029/g,'\\u2029');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>All RPG test results</title><style>
:root{color-scheme:dark;font:16px/1.5 system-ui;background:#101426;color:#e7e9f7}*{box-sizing:border-box}body{margin:0}a{color:#b5cdff}button,input,select{font:inherit}button,select,input{background:#1b2340;color:inherit;border:1px solid #53618c;border-radius:7px;padding:8px 12px}button{cursor:pointer}button:hover{background:#2d395a}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #b5cdff;outline-offset:3px}aside{position:fixed;inset:0 auto 0 0;width:285px;padding:24px 18px;overflow:auto;background:#151c31;border-right:1px solid #394569}aside a{display:block;padding:9px 4px;text-decoration:none}aside a:hover{text-decoration:underline}aside span{float:right;padding-left:5px}main{margin-left:285px;padding:30px;max-width:1650px}h1{margin-top:0}h2{margin-top:0}.muted{color:#aab5d1;overflow-wrap:anywhere}select{max-width:100%;min-width:0}.suite-tools select{flex:1}.pass{color:#82e4ab}.fail{color:#ff9f9f}section{scroll-margin-top:16px;margin:22px 0;padding:22px;border:1px solid #394569;border-radius:12px}.toolbar,.suite-tools{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.toolbar{position:sticky;top:0;z-index:2;background:#101426f5;padding:12px 0;border-bottom:1px solid #394569}input[type=search]{flex:1;min-width:210px}label{display:flex;gap:8px;align-items:center}details{border:1px solid #394569;border-radius:8px;padding:12px;margin:9px 0}summary{cursor:pointer;overflow-wrap:anywhere}summary span{display:inline-block;min-width:47px;font-weight:750}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;max-height:600px;overflow:auto}table{border-collapse:collapse;width:100%;font-size:14px}th,td{border:1px solid #394569;padding:8px;text-align:left;overflow-wrap:anywhere}.suite-tools{margin-bottom:16px}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(215px,1fr));gap:14px}.shot{display:grid;gap:7px;text-align:left;overflow-wrap:anywhere;font-size:13px}.shot img{width:100%;height:145px;object-fit:contain;background:#080b14}iframe{width:100%;height:75vh;border:1px solid #53618c;border-radius:8px;background:#101426}dialog{border:1px solid #53618c;border-radius:12px;background:#151c31;color:inherit;max-width:95vw}dialog::backdrop{background:#000c}dialog img{display:block;max-width:85vw;max-height:75vh;object-fit:contain;margin:15px auto}.original-image{max-width:100%;max-height:80vh;object-fit:contain}[hidden]{display:none!important}@media(max-width:900px){aside{position:relative;width:100%;max-height:240px;border-right:0;border-bottom:1px solid #394569}main{margin-left:0;padding:16px}.toolbar{position:static}section{padding:14px}}
</style></head><body><aside aria-label="Report navigation"><strong>RPG test results</strong><a href="#overview">Overview</a><button id="only-failures">Show failures only</button><nav id="suite-links" aria-label="Test suites"></nav><a href="#screenshots">Screenshots</a><a href="#original-files">Original reports, JSON and logs</a><button id="download-json">Download combined JSON</button></aside><main>
<section id="overview"><h1>All game test results</h1><h2 id="totals"></h2><p id="timestamp" class="muted"></p><p>Every original result, log and screenshot is embedded in this file. No server or internet connection is needed. Older report copies are retained under Original files. Save-flow counts as one integration scenario; its full assertions remain in its log.</p><p class="muted">These regression cases do not prove every possible battle state is correct.</p></section>
<div class="toolbar" aria-label="Filter test results"><input id="search" type="search" placeholder="Search tests, characters, errors or evidence" aria-label="Search test results"><label><input type="checkbox" id="failures">Failures only</label><select id="group" aria-label="Test group"></select><button id="clear">Clear filters</button><button id="open-visible">Expand visible checks</button><button id="close-all">Collapse all</button><span id="matching" role="status"></span></div><div id="suites"></div>
<section id="screenshots"><h2>Screenshots</h2><p>Click an image to enlarge it or download its original bytes.</p><div id="gallery" class="gallery"></div></section>
<section id="original-files"><h2>Original reports, JSON, logs and assets</h2><p>View any original report with its embedded images, inspect the complete raw data, or download the original file. SHA-256 checksums identify the preserved bytes.</p><div class="suite-tools"><input id="file-search" type="search" placeholder="Filter original filenames" aria-label="Search original filenames"><select id="file-select" aria-label="Original file"></select><button id="download-file">Download selected file</button><button id="export-originals">Export all originals as JSON</button></div><p id="file-status" class="muted" role="status"></p><div id="file-preview"></div></section>
<dialog id="image-dialog"><div class="suite-tools"><strong id="image-title"></strong><button id="image-download">Download image</button><button id="image-close">Close</button></div><img id="large-image" alt="Expanded test screenshot"></dialog>
<script type="application/json" id="rpg-report-payload">${json}</script><script>(${reportClient.toString()})();</script></main></body></html>`;
}

async function main(){
  if(process.argv.includes('--merge-reports')){await mergeExistingReports(absolutePath(process.env.RPG_ALL_REPORT_DIR||absolutePath(PROJECT_ROOT,'test-results')));return;}
  if(process.argv.includes('--list')){for(const s of SUITES)console.log(`${s.id}: ${s.name}`);return;}
  const args=process.argv.slice(2),requested=args.length===2&&args[0]==='--suite'?args[1]:null;
  if(args.length&&!requested)throw Error('Usage: node scripts/test-game.mjs [--suite <id|unit> | --list]');
  const selected=requested==='unit'?SUITES.filter(s=>s.unit):requested?SUITES.filter(s=>s.id===requested):SUITES;
  if(!selected.length)throw Error('Unknown suite: '+requested+'. Use --list.');
  const reportRoot=absolutePath(process.env.RPG_ALL_REPORT_DIR||absolutePath(PROJECT_ROOT,'test-results'));
  await makeDirectory(reportRoot,{recursive:true});
  const temporary=await makeTemporaryDirectory(absolutePath(temporaryRoot(),'rpg-all-tests-'));
  const rows=[],artifacts=[];
  const cancel=()=>{interrupted=true;for(const child of ownedChildren)stopOwned(child);};
  process.once('SIGINT',cancel);process.once('SIGTERM',cancel);
  try{
    for(const suite of selected){
      if(interrupted)break;
      console.log(`\nRunning ${suite.name} (${rows.length+1}/${selected.length})`);
      // A unique directory per run prevents stale reports from counting as current results.
      const stage=absolutePath(temporary,'reports',suite.id);await makeDirectory(stage,{recursive:true});
      const row=await runSection(suite,stage,temporary);
      artifacts.push(...await collectReportArtifacts(stage,suite.id+'/'));
      if(row.report)row.report=suite.id+'/'+row.report;
      rows.push(row);
      await writeCombined(reportRoot,rows,artifacts);
      console.log(`${suite.id}: ${row.passed} passed, ${row.failed} failed${row.ok?'':' (suite failed)'}`);
    }
    const report=await writeCombined(reportRoot,rows,artifacts);
    console.log(`\nAll tests: ${report.passed} passed, ${report.failed} failed; ${report.failedSuites} failed suites; ${report.skipped||0} pending/skipped.\nReport: ${absolutePath(reportRoot,'all-tests-report.html')}`);
    process.exitCode=interrupted?130:report.failedSuites?1:0;
  }finally{
    for(const child of [...ownedChildren])await releaseOwned(child);
    await removeTemporaryDirectory(temporary,{recursive:true,force:true,maxRetries:3,retryDelay:200});
    process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel);
  }
}

// ========================================================================
// testDatabase: merged from test/store.test.js
// ========================================================================
async function testDatabase() {
const {default:test}=await import('node:test');const {default:assert}=await import('node:assert/strict');
const {createStore}=await import('../server/store.js');const {createDatabase}=await import('../server/database.js');const {initializeSchema}=await import('../server/initialize-schema.js');const {createApi}=await import('../server/api.js');
function checkpoint(battleId = 'battle-1', sequence = 0) {
  return {
    battleId, decisions: [],
    state: {
      schemaVersion: 2, battleId, sequence, turn: 1,
      party: [{ name: 'Niko Himura', hp: 100, en: 200, alive: true, _turnStarted: true, guarding: false, status: { burn: 2 }, cooldowns: { surprise: 4 } }],
      enemies: [{ name: 'Soulless Survivor', hp: 40000, en: 2100, status: {} }],
      flags: { phase: 'player', _inPlayerPhase: true, currentActorIdx: 0, _actedThisPhase: [false] }
    },
    inventory: [{ item_id: 'noodles', quantity: 3 }]
  };
}
function decision(n = 1, battleId = 'battle-1') {
  return { id: `${battleId}-decision-${n}`, sequenceNumber: n, turnNumber: 1, actorId: 'Niko Himura', actionType: 'guard', abilityOrItemId: null, targets: [], result: { log: ['Niko guards.'] } };
}
async function withStore(fn){const db=await createDatabase({env:{},localPath:':memory:'});await initializeSchema(db);const s=createStore(db);try{await fn(s,db);}finally{await s.close();}}

test('five manual slots, protected opening autosave and atomic inventory',()=>withStore(async s=>{
 await s.save('alice',6,checkpoint(),true);
 for(let slot=1;slot<=5;slot++){const p=checkpoint();p.state.party[0].hp=slot*10;p.inventory[0].quantity=slot;await s.save('alice',slot,p);}
 assert.equal((await s.list('alice')).length,6);assert.equal((await s.load('alice',3)).state.party[0].hp,30);assert.equal((await s.load('alice',3)).inventory[0].quantity,3);assert.equal((await s.load('alice',6)).state.party[0].hp,100);
 await assert.rejects(()=>s.save('alice',6,checkpoint()));await assert.rejects(()=>s.save('alice',7,checkpoint()));
 await s.save('alice',6,checkpoint('battle-2'),true);assert.equal((await s.load('alice',6)).state.battleId,'battle-2');assert.equal((await s.history('alice')).length,2);
}));
test('history retries do not advance checkpoint slots',()=>withStore(async s=>{
 await s.save('alice',6,checkpoint(),true);await s.save('alice',1,checkpoint());const event={battleId:'battle-1',decisions:[decision()]};await s.events('alice',event);await s.events('alice',event);
 assert.equal((await s.history('alice'))[0].decisions.length,1);assert.equal((await s.load('alice',6)).state.sequence,0);assert.equal((await s.load('alice',1)).state.sequence,0);
 const manual=checkpoint('battle-1',1);manual.inventory[0].quantity=2;await s.save('alice',1,manual);assert.equal((await s.load('alice',1)).state.sequence,1);assert.equal((await s.load('alice',6)).inventory[0].quantity,3);
 await s.events('alice',{...event,decisions:[],outcome:'victory'});assert.equal((await s.history('alice'))[0].outcome,'victory');
}));
test('resumed checkpoints branch without rewriting source history',()=>withStore(async s=>{
 await s.save('alice',1,checkpoint());await s.events('alice',{battleId:'battle-1',decisions:[decision(),decision(2)]});const branch=checkpoint('resumed-1');branch.sourceBattleId='battle-1';branch.sourceSequence=0;
 await s.events('alice',{...branch,decisions:[decision(1,'resumed-1')]});branch.state.sequence=1;await s.save('alice',2,branch);
 assert.equal((await s.load('alice',1)).state.sequence,0);assert.equal((await s.load('alice',2)).state.sequence,1);const h=await s.history('alice');assert.equal(h.find(b=>b.id==='battle-1').decisions.length,2);assert.equal(h.find(b=>b.id==='resumed-1').source_battle_id,'battle-1');
 await assert.rejects(()=>s.save('alice',6,{...branch,state:{...branch.state,sequence:0}},true));
}));
test('SQL ownership isolates slots, histories and resume sources',()=>withStore(async s=>{
 await s.save('alice',6,checkpoint(),true);assert.equal(await s.load('bob',6),null);assert.deepEqual(await s.list('bob'),[]);assert.deepEqual(await s.history('bob'),[]);
 await assert.rejects(()=>s.save('bob',1,checkpoint()));await assert.rejects(()=>s.events('bob',{battleId:'other',sourceBattleId:'battle-1',sourceSequence:0}));
 assert.equal((await s.load('alice',6)).inventory[0].quantity,3);
}));
test('failed decision batch rolls back history, state and inventory',()=>withStore(async s=>{
 await s.save('alice',1,checkpoint());const p=checkpoint('battle-1',2);p.state.party[0].hp=1;p.inventory[0].quantity=0;p.decisions=[decision(),{...decision(2),id:decision().id}];
 await assert.rejects(()=>s.save('alice',1,p));assert.equal((await s.load('alice',1)).state.party[0].hp,100);assert.equal((await s.load('alice',1)).inventory[0].quantity,3);assert.equal((await s.history('alice'))[0].decisions.length,0);
}));
test('only valid prepared player turns can be saved',()=>withStore(async s=>{
 for(const modify of [p=>p.state.flags.phase='enemy',p=>p.state.flags._actedThisPhase[0]=true,p=>p.state.party[0]._turnStarted=false,p=>p.inventory[0].quantity=-1,p=>p.state.party[0].hp=-1]){const p=checkpoint();modify(p);await assert.rejects(()=>s.save('alice',1,p));}
 assert.equal(await s.load('alice',1),null);
}));
test('opening autosave retries cannot replace a newer battle opening',()=>withStore(async s=>{
 const opening=checkpoint();await s.save('alice',6,opening,true);await s.save('alice',6,opening,true);await s.save('alice',6,checkpoint('battle-2'),true);await assert.rejects(()=>s.save('alice',6,opening,true));assert.equal((await s.load('alice',6)).state.battleId,'battle-2');
}));
test('large Unicode snapshots and decision results round-trip across SQL chunks',()=>withStore(async s=>{
 const p=checkpoint();p.state.unusual='🙂漢字'.repeat(180000);await s.save('alice',1,p);assert.deepEqual((await s.load('alice',1)).state,p.state);
 const d=decision();d.result={text:'🧪'.repeat(300000)};await s.events('alice',{battleId:p.battleId,decisions:[d]});assert.deepEqual(JSON.parse((await s.history('alice'))[0].decisions[0].result_json),d.result);
 p.state.party[0].hp=60;p.state.sequence=1;await s.save('alice',1,p);assert.equal((await s.load('alice',1)).state.party[0].hp,60);await s.maintenance('alice');assert.equal((await s.load('alice',1)).state.unusual.length,p.state.unusual.length);
}));
test('OCC commit conflict retries the entire SQL transaction',()=>withStore(async(s,db)=>{
 let commits=0;const flaky={...db,async connect(){const c=await db.connect();return {release:()=>c.release(),query(sql,args){if(sql==='COMMIT'&&commits++===0)throw Object.assign(Error('injected OCC conflict'),{code:'40001'});return c.query(sql,args);}};}};
 const retrying=createStore(flaky,{delay:async()=>{}});await retrying.save('alice',1,checkpoint());assert.equal(commits,2);assert.equal((await s.history('alice')).length,1);assert.equal((await s.load('alice',1)).state.party[0].hp,100);
}));
test('exhausted OCC retry returns 503 and leaves previous checkpoint intact',()=>withStore(async(s,db)=>{
 await s.save('alice',1,checkpoint());const flaky={...db,async connect(){const c=await db.connect();return {release:()=>c.release(),query(sql,args){if(sql==='COMMIT')throw Object.assign(Error('OCC'),{code:'40001'});return c.query(sql,args);}};}};
 const p=checkpoint();p.state.party[0].hp=20;await assert.rejects(()=>createStore(flaky,{maxAttempts:2,delay:async()=>{}}).save('alice',1,p),e=>e.status===503);assert.equal((await s.load('alice',1)).state.party[0].hp,100);
}));
test('Lambda v2 cookies, HTTPS origin validation and protected slots',()=>withStore(async s=>{
 const api=createApi(s,{logger:{error(){}}});const event={rawPath:'/api/saves',headers:{origin:'https://game.example','x-rpg-site-origin':'https://game.example'},requestContext:{http:{method:'GET'}}};const empty=await api(event);assert.equal(empty.statusCode,200);assert.match(empty.cookies[0],/HttpOnly/);assert.match(empty.cookies[0],/Secure/);assert.match(empty.cookies[0],/SameSite=Strict/);const cookies=[empty.cookies[0].split(';')[0]];
 const write={...event,rawPath:'/api/autosave',cookies,headers:{...event.headers,'content-type':'application/json'},body:JSON.stringify(checkpoint()),requestContext:{http:{method:'POST'}}};assert.equal((await api(write)).statusCode,200);
 const load=await api({...event,rawPath:'/api/saves/6',cookies});assert.equal(JSON.parse(load.body).state.party[0].hp,100);
 assert.equal((await api({...write,headers:{...write.headers,origin:'https://evil.example'}})).statusCode,403);
 assert.equal((await api({...write,rawPath:'/api/saves/6',requestContext:{http:{method:'PUT'}}})).statusCode,400);
 assert.equal((await api({...write,body:'{' })).statusCode,400);
}));
test('chunked upload commits atomically, is retry-safe and owner-scoped',()=>withStore(async s=>{
 const p=checkpoint();p.state.large='🧪'.repeat(90000);const bytes=Buffer.from(JSON.stringify(p)),id='00000000-0000-4000-8000-000000000001',size=100000,total=Math.ceil(bytes.length/size);
 for(let i=0;i<total;i++)await s.stageUpload('alice',{id,index:i,total,path:'/api/saves/1',method:'PUT',data:bytes.subarray(i*size,(i+1)*size).toString('base64')});
 await assert.rejects(()=>s.commitUpload('bob',id));assert.equal(await s.load('alice',1),null);await s.commitUpload('alice',id);await s.commitUpload('alice',id);assert.deepEqual((await s.load('alice',1)).state,p.state);
 const response=await s.stageResponse('alice',Buffer.from(JSON.stringify((await s.load('alice',1)))));const b=[];for(let i=0;i<response.__rpgChunked.parts;i++)b.push(Buffer.from((await s.responsePart('alice',response.__rpgChunked.id,i)).data,'base64'));assert.deepEqual(JSON.parse(Buffer.concat(b)).state,p.state);await assert.rejects(()=>s.responsePart('bob',response.__rpgChunked.id,0));
}));
test('Legacy migration preserves checkpoint, inventory, branch history and decisions without overwrite',()=>withStore(async(s,db)=>{
 const {importLegacy}=await import('../server/import-legacy.js');const p=checkpoint(),time='2026-01-01 00:00:00';
 const legacy={players:[{id:'alice',display_name:'Player'}],battles:[{id:p.battleId,player_id:'alice',encounter_id:'soulless-survivor',source_battle_id:null,source_sequence:null,opening_saved:1,outcome:'victory',started_at:time,ended_at:time}],saves:[{id:'legacy-slot',player_id:'alice',slot:6,battle_id:p.battleId,schema_version:2,state_json:JSON.stringify(p.state),updated_at:time}],inventory:[{save_id:'legacy-slot',...p.inventory[0]}],combat_decisions:[{id:'legacy-decision',battle_id:p.battleId,sequence_number:1,turn_number:1,actor_id:'Niko Himura',action_type:'guard',ability_or_item_id:null,targets_json:'[]',result_json:'{"text":"🧪"}',created_at:time}]};
 legacy.battles.push({...legacy.battles[0],id:'legacy-branch',source_battle_id:p.battleId,source_sequence:0,outcome:null,ended_at:null});
 await importLegacy(db,legacy);assert.deepEqual((await s.load('alice',6)).state,p.state);assert.deepEqual((await s.load('alice',6)).inventory,p.inventory);const h=await s.history('alice'),parent=h.find(b=>b.id===p.battleId),branch=h.find(b=>b.id==='legacy-branch');assert.equal(parent.outcome,'victory');assert.equal(parent.last_sequence,1);assert.equal(parent.decisions[0].result_json,legacy.combat_decisions[0].result_json);assert.equal(branch.source_battle_id,p.battleId);assert.equal(branch.source_sequence,0);await assert.rejects(()=>importLegacy(db,legacy),/empty target/);assert.equal((await s.history('alice')).length,2);
}));
test('Legacy import SQL failure rolls back the entire dataset',()=>withStore(async(s,db)=>{
 const {importLegacy}=await import('../server/import-legacy.js');const p=checkpoint();const legacy={players:[{id:'alice',display_name:'Player'}],battles:[],saves:[{id:'missing-parent',player_id:'alice',slot:1,battle_id:p.battleId,schema_version:2,state_json:JSON.stringify(p.state),updated_at:'now'}],inventory:[],combat_decisions:[]};await assert.rejects(()=>importLegacy(db,legacy));const c=await db.connect();try{assert.equal(Number((await c.query('SELECT COUNT(*) AS n FROM players')).rows[0].n),0);}finally{c.release();}
}));
test('Lambda refuses local fallback and DSQL needs an explicit region',async()=>{
 await assert.rejects(()=>createDatabase({env:{AWS_LAMBDA_FUNCTION_NAME:'game',DATABASE_URL:'postgres://unused'},localPath:':memory:'}),/Lambda requires/);
 await assert.rejects(()=>createDatabase({env:{RPG_DSQL_HOST:'example.dsql.eu-west-1.on.aws'}}),/AWS_REGION/);
});
test('Deployment keeps the database and API private and forwards signed bodies without caching',async()=>{
 const {readFile}=await import('node:fs/promises');const t=JSON.parse(await readFile(new URL('../aws/template.json',import.meta.url),'utf8')),r=t.Resources;
 assert.equal(r.SaveFunction.Properties.FunctionUrlConfig.AuthType,'AWS_IAM');assert.equal(r.GameDatabase.DeletionPolicy,'Retain');assert.equal(r.GameDatabase.Properties.DeletionProtectionEnabled,true);
 const config=r.Distribution.Properties.DistributionConfig,api=config.CacheBehaviors.find(b=>b.PathPattern==='/api/*');assert.equal(api.CachePolicyId,'4135ea2d-6df8-44a3-9df3-4b5a84be39ad');
 assert.equal(r.AllowCloudFrontUrl.Properties.Action,'lambda:InvokeFunctionUrl');assert.equal(r.AllowCloudFrontInvoke.Properties.InvokedViaFunctionUrl,true);assert.ok(r.AllowCloudFrontInvoke.Properties.SourceArn);
 assert.equal(r.SiteBucket.Properties.PublicAccessBlockConfiguration.BlockPublicPolicy,true);assert.equal(r.ApiRequestPolicy.Properties.OriginRequestPolicyConfig.CookiesConfig.CookieBehavior,'all');assert.ok(r.ApiRequestPolicy.Properties.OriginRequestPolicyConfig.HeadersConfig.Headers.includes('x-amz-content-sha256'));
 const {runInNewContext}=await import('node:vm');const request={headers:{host:{value:'game.example'},'x-rpg-site-origin':{value:'https://evil.example'}}};const context={};runInNewContext(r.ApiSiteHeader.Properties.FunctionCode,context);assert.equal(context.handler({request}).headers['x-rpg-site-origin'].value,'https://game.example');
});
test('Live Aurora DSQL/IAM deployment', {skip:'Requires deployment to an AWS account; local PostgreSQL tests do not validate live DSQL or CloudFront IAM.'},()=>{});
test('incomplete/conflicting upload cannot create a partial checkpoint',()=>withStore(async s=>{
 const id='00000000-0000-4000-8000-000000000002',part={id,index:0,total:2,path:'/api/saves/1',method:'PUT',data:Buffer.from('{}').toString('base64')};await s.stageUpload('alice',part);await s.stageUpload('alice',part);await assert.rejects(()=>s.stageUpload('alice',{...part,data:Buffer.from('[]').toString('base64')}));await assert.rejects(()=>s.commitUpload('alice',id));assert.equal(await s.load('alice',1),null);
}));
}

// ========================================================================
// testBrowserSelection: merged from test/browser-selection.test.js
// ========================================================================
async function testBrowserSelection() {
const { default: test } = await import("node:test");
const { default: assert } = await import("node:assert/strict");
const { resolveTestBrowser } = await import("../scripts/default-test-browser.mjs");
const mock = (name, bundleId, executable = '/browser/' + name) => ({ name, bundleId, executable });

test('the selected system browser wins over other installed browser brands', async () => {
  const inspected=[];
  const browser=await resolveTestBrowser({ platform:'darwin',env:{},getDefault:async()=>'/Applications/Firefox.app',inspect:async path=>{inspected.push(path);return mock('Firefox','org.mozilla.firefox');} });
  assert.equal(browser.engine,'firefox');assert.equal(browser.source,'system default browser');
  assert.deepEqual(inspected,['/Applications/Firefox.app']);
});
test('a Chromium default uses the Chromium driver', async () => {
  const browser=await resolveTestBrowser({platform:'darwin',env:{},getDefault:async()=>'/Applications/Google Chrome.app',inspect:async()=>mock('Google Chrome','com.google.chrome')});
  assert.equal(browser.engine,'chromium');assert.equal(browser.name,'Google Chrome');
});
test('Brave is used only if it is the selected browser',async()=>{
  const browser=await resolveTestBrowser({platform:'darwin',env:{},getDefault:async()=>'/Applications/Brave Browser.app',inspect:async()=>mock('Brave Browser','com.brave.Browser')});
  assert.equal(browser.engine,'chromium');assert.equal(browser.source,'system default browser');
});
test('failure to resolve the default never selects another app',async()=>{
  let inspected=false;
  await assert.rejects(resolveTestBrowser({env:{},getDefault:async()=>{throw Error('OS lookup failed');},inspect:async()=>{inspected=true;}}),/OS lookup failed/);
  assert.equal(inspected,false);
});
test('missing default executable stops without fallback',async()=>{
  let inspections=0;
  await assert.rejects(resolveTestBrowser({env:{},getDefault:async()=>'/missing/default',inspect:async()=>{inspections++;throw Error('Missing executable');}}),/No alternative browser was selected/);
  assert.equal(inspections,1);
});
test('unsupported default stops before launching or substituting a browser',async()=>{
  await assert.rejects(resolveTestBrowser({env:{},getDefault:async()=>'/Applications/Safari.app',inspect:async()=>mock('Safari','com.apple.Safari')}),/No browser was opened or substituted/);
});
test('an explicit override is honored without reading default settings',async()=>{
  const browser=await resolveTestBrowser({env:{RPG_TEST_BROWSER:'/custom/chromium'},getDefault:async()=>{throw Error('Should not query default');},inspect:async path=>{assert.equal(path,'/custom/chromium');return mock('Chromium','org.chromium.Chromium',path);}});
  assert.equal(browser.source,'explicit RPG_TEST_BROWSER override');
});
test('an invalid explicit override never silently falls back',async()=>{
  let queried=false;
  await assert.rejects(resolveTestBrowser({env:{RPG_TEST_BROWSER:'/missing'},getDefault:async()=>{queried=true;},inspect:async()=>{throw Error('Missing');}}),/RPG_TEST_BROWSER/);
  assert.equal(queried,false);
});

}

// ========================================================================
// testSkills: merged from scripts/verify-all-skills.mjs
// ========================================================================
async function testSkills() {
/**
 * Real-engine skill regression suite. Run: npm run test:skills
 * No npm dependencies. Requires Node 22.13+ and a supported system default browser (Firefox or Chromium).
 * Uses the system default browser; an alternative requires explicit RPG_TEST_BROWSER.
 * The game is served from memory with a TEST-ONLY adapter injected into its closure.
 * Production HTML is never rewritten. No save/database API is started or contacted.
 * Rendering, audio, dialogue waits and turn advancement are isolated; actual skill,
 * damage, status, cost, passive, targeting and enemy-action implementations are used.
 */
const { readFile, writeFile, mkdir, mkdtemp, rm } = await import("node:fs/promises");
const { createServer } = await import("node:http");
const { spawn } = await import("node:child_process");
const { tmpdir } = await import("node:os");
const { resolve, extname, sep } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { launchTestBrowser } = await import("./browser-automation.mjs");

function installSkillHarness() {
  const results = [], covered = new Set();
  let messages = [], advances = 0, randomValue = 0.2;
  const realRandom = Math.random;
  const copy = value => JSON.parse(JSON.stringify(value));
  const fail = message => { throw new Error(message); };
  const ok = (condition, message) => { if (!condition) fail(message); };
  const eq = (actual, expected, message) => ok(Object.is(actual, expected), `${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  const same = (actual, expected, message) => eq(JSON.stringify(actual), JSON.stringify(expected), message);
  // Suppress presentation only, keeping all effect and validation functions real.
  log = message => messages.push(String(typeof message === 'object' ? message.text : message));
  renderBars = () => {}; renderCommandMenu = () => {}; renderSkillsMenu = () => {};
  sayOne = () => {}; playSfxKey = () => {}; queueHurtFlash = () => {};
  setTurnBanner = () => {}; sleep = async () => {};
  advanceAfterPlayerAction = () => { advances++; _actionInFlight = false; };
  ensureSummonWrapupBeforeEnemyPhase = async () => {};
  ensureSSZeroHPDialogueBeforeEnemyPhase = async () => {};
  ensurePhase2DialogueBeforeEnemyPhase = async () => {};
  waitForBattleDialogueToFinishV74 = async () => {};
  const originalEnemyPhase = enemyPhase;
  const originalActionsForEnemy = actionsForEnemy;
  const originalChooseBossAction = chooseBossAction;
  const originalMoreVictims = ssTryMoreVictims;
  const catalog = Object.keys(ROSTER).flatMap(character => getActorSkills({ name: character }).map(skill => ({ character, ...copy(skill) })));
  const byKey = new Map(catalog.map(skill => [skill.key, skill]));
  function enemy(name) {
    const unit = makeEnemy(name, 100000, 250, 20, 0, 10000, 'high');
    unit.hp = unit.maxHP = 100000; unit.baseAcc = 2;
    if (name === 'Soulless Survivor') unit._analytical = { active: false, current: null, phaseCounter: 0 };
    if (name === 'Itachi Himura' || name === 'Dr. Hirose Yuki') unit._summonedBySS = true;
    return unit;
  }
  function fixture(character, key, options = {}) {
    Math.random = () => randomValue; randomValue = options.random ?? 0.2;
    resetBattleProgress();
    messages = []; advances = 0;
    const names = [...new Set([character, 'Niko Himura', 'Towa Himura', 'Toshiro Yoshikawa', 'Miya Hagimoto', 'Hotaru Minami'])].slice(0, 4);
    party = names.map(name => {
      const unit = buildStatsFromTiers(name, normalizeTiers(ROSTER[name]));
      unit.maxHP = 10000; unit.hp = name === character ? 10000 : 5000;
      unit.maxEN = 10000; unit.en = name === character ? 10000 : 5000;
      unit.baseAcc = 2; unit._turnStarted = true;
      return unit;
    });
    enemies = options.observer || key === 'riskit'
      ? [enemy('Soulless Survivor'), enemy('Itachi Himura'), enemy('Dr. Hirose Yuki')]
      : [enemy('Training Target A'), enemy('Training Target B'), enemy('Soulless Survivor')];
    currentActorIdx = 0; phase = 'player'; _inPlayerPhase = true;
    _actedThisPhase = party.map(() => false); _actionInFlight = false;
    inSpecialDialogue = false; _battleDialogueLockDepth = 0; _inPrefightFlow = false;
    riskItUsedThisBattle = false; selectedAction = 'skill'; pendingSkill = null; _pickCtx = null; followCtx = null;
    bag = defaultBag(); ENEMY_LOG = false; _currentEnemyAttacker = null; _critCtx = { active: false, seen: new Set() };
    window.__battleDialogueHardLockV72 = false;
    window.__ssDefeatEndingStartedV89 = false; window.__ssDefeatEndingStartedV92 = false;
    window.__nikoGameOverShiftDisabledV57 = false;
    window.__openMimicMenuContext = null;
    UI.selectPanel.style.display = 'none'; UI.battleUI.style.display = ''; UI.overlay.style.display = 'none';
    UI.menu.replaceChildren(); UI.subMenu.replaceChildren();
    const user = party[0], skill = byKey.get(key);
    let target = skill?.target === 'ally' ? party[1] : enemies[0];
    if (key === 'riskit') target = enemies[1];
    if (key === 'uber') target = enemies.find(isSS);
    if (key === 'eye') { target.hp = 0; target.en = 0; target.alive = false; }
    if (key === 'honor') enemies.forEach(e => Object.assign(e.status, { atkUp: 3, defUp: 3, spdUp: 3, accUp: 3 }));
    if (key === 'toshCheatback') Object.assign(party[1].status, { atkDown: 3, defDown: 2, accDown: 1, spdWeaken: 2, defCrash: 2 });
    // Passive Surprise is tested separately; do not add it to unrelated skill damage.
    if (character === 'Hotaru Minami') user.surpriseReady = false;
    return { user, skill, target, before: copy({ party, enemies }), hp: user.hp, en: user.en };
  }
  function cast(f, target = f.target) { useSkill(f.skill, ['ally', 'enemy'].includes(f.skill.target) ? target : null); }
  function intact() {
    for (const unit of [...party, ...enemies]) {
      ok(Number.isFinite(unit.hp) && Number.isFinite(unit.en), `${unit.name}: finite HP/EN`);
      ok(unit.hp >= 0 && unit.hp <= unit.maxHP && unit.en >= 0 && unit.en <= unit.maxEN, `${unit.name}: HP/EN in bounds`);
    }
    ok(!messages.some(line => /Unhandled skill kind|An error interrupted|There is an issue|There's an issue|\(engine\).*error/i.test(line)), 'Engine did not swallow an error or use an unhandled skill');
  }
  async function check(character, skill, scenario, fn) {
    const start = performance.now();
    try { await fn(); intact(); results.push({ character, skill, scenario, passed: true, ms: +(performance.now() - start).toFixed(2) }); }
    catch (error) { results.push({ character, skill, scenario, passed: false, error: error.stack || String(error), log: messages.slice(-15) }); }
    finally { Math.random = realRandom; }
  }
  const damageKeys = new Set(['dontbottle','cutting','trueSide','malware','ransom','homerun','allbark','onearmy','headache','akioBack','akioExplode','akioPositive','toshMydoom']);
  const statusCases = {
    gloom: 'despair', towaVengeance: 'rage', akioDream: 'rage', akioExplode: 'burn', akioPositive: 'despair', allbark: 'brainwash', onearmy: 'brainwash', malware: 'crash', ransom: 'crash', toshMydoom: 'crash', toshUltimateAilment: 'any'
  };
  function affected(f) { return f.skill.target === 'enemy' ? [f.target] : enemies; }
  function expectStatus(unit, key, active) {
    const present = key === 'crash' ? unit.stunTurns > 0 && unit.status.defDown > 0
      : key === 'any' ? ['brainwash','rage','despair'].some(k => unit.status[k] > 0) : unit.status[key] > 0;
    eq(present, active, `${unit.name}: ${key} ${active ? 'applied' : 'not applied'}`);
  }
  const effects = {
    gloom: f => affected(f).forEach(e => expectStatus(e,'despair',true)),
    dontbottle: damage, cutting: damage,
    riskit: f => { eq(f.before.enemies[1].hp - f.target.hp, Math.floor(f.target.maxHP * 0.30), 'Cuts exactly 30% max HP'); eq(f.user.status.defCrash,1,'Self DEF crash lasts one turn'); ok(riskItUsedThisBattle,'Once-per-battle flag'); },
    vengeance: f => party.forEach(p => eq(p.status.atkUp,3,'ATK duration')),
    science: f => party.forEach(p => eq(p.status.defUp,3,'DEF duration')),
    truth: follow,
    cheatcode: heal, eye: f => { eq(f.target.hp,f.target.maxHP,'Revived at full HP'); ok(f.target.alive,'Revived ally alive'); ok(f.target.en >= Math.ceil(f.target.maxEN * 0.25),'Revive restores at least 25% EN'); },
    trueSide: damage, damsel: taunting, uber: f => eq(f.target._hackedActions,2,'Two hijacked enemy actions'),
    sneak: f => party.forEach(p => {eq(p.status.spdBoost,3,'Double speed duration'); const base=p.dodge; eq(dodgeOf(p),Math.min(.95,base*2),'Effective speed doubled');}),
    malware: damage, ransom: damage,
    tsundere: taunting,
    smoke: f => enemies.forEach(e => {eq(e.status.spdWeaken,3,'SPD debuff duration');eq(e.status.accWeaken,3,'ACC debuff duration');eq(accOf(e),e.baseAcc*.5,'Accuracy halved');}),
    homerun: damage,
    leverage: f => enemies.forEach(e => {eq(e.status.atkDown,3,'ATK debuff duration');eq(e.status.defDown,3,'DEF debuff duration');}),
    allbark: damage, onearmy: damage,
    unity: f => party.forEach(p => eq(p.status.critBoost,6,'Critical aura duration')),
    honor: f => enemies.forEach(e => ['atkUp','defUp','spdUp','accUp'].forEach(k=>eq(e.status[k],0,'Enemy '+k+' removed'))),
    towaNotebook: f => {
      ok(towaNotebookArmed,'Notebook armed'); phase='enemy'; beginTowaNotebookEnemyPhase();
      const ally=party.find(p=>p.name==='Niko Himura'); ally._nikoNotYetUsed=true;
      const akio=party.find(p=>p.name==='Akio Mamoru'); if(akio)akio._loversSpecialAvailable=false;
      ally.en=0; applyDamageToAlly(ally,ally.maxHP*2); ally.alive=false;
      resolveTowaNotebookAfterEnemyPhase(); eq(ally.hp,ally.maxHP,'Notebook revives full HP'); ok(ally.alive,'Notebook revives Niko');eq(ally.en,Math.ceil(ally.maxEN*.25),'Notebook revive energy floor');
      ok(!towaNotebookArmed&&!towaNotebookEnemyActive,'Notebook expires after one enemy phase');phase='player';
    },
    beaming: heal,
    glory: f => party.forEach(p=>eq(p.status.atkUp,6,'ATK duration')),
    haveMercy: f => enemies.forEach(e=>eq(e.status.atkDown,6,'ATK reduction duration')),
    towaVengeance: f => expectStatus(f.target,'rage',true),
    headache: f => {damage(f);enemies.forEach(e=>eq(e.status.spdWeaken,3,'SPD debuff duration'));},
    addedTeamwork: follow,
    adminHack: f => eq(f.target.en,Math.floor(f.before.enemies[0].en*.25),'Removes 75% current EN'),
    akioMimic: f => {eq(advances,0,'Opening Mimic does not consume turn');ok(UI.subMenu.textContent.includes('Copy from'),'Mimic lists source characters');},
    akioBack: damage, akioJester: taunting,
    akioTeam: f => {party.forEach(p=>eq(p.status.teamTriple,1,'One triple-damage action'));eq(useTeamTriple(f.user),3,'Triple multiplier applied');eq(useTeamTriple(f.user),1,'Triple multiplier consumed once');},
    akioExplode: damage, akioPositive: damage,
    akioDream: f => enemies.forEach(e=>expectStatus(e,'rage',true)),
    akioCollab: follow,
    toshUltimateAilment: f => enemies.forEach(e=>expectStatus(e,'any',true)),
    toshUltimateHack: f => {enemies.forEach(e=>eq(e.status.defDown,1,'Enemy DEF down duration'));party.forEach(p=>eq(p.status.teamDouble,1,'One double-damage action'));eq(useTeamTriple(f.user),2,'Double multiplier applied');eq(useTeamTriple(f.user),1,'Double multiplier consumed once');},
    toshCheatback: f => {party.forEach(p=>['atkDown','defDown','accDown','spdWeaken','defCrash'].forEach(k=>eq(p.status[k]||0,0,'Ally '+k+' cleansed')));enemies.forEach(e=>{eq(e.status.atkDown,3,'Reflected ATK debuff');eq(e.status.defDown,2,'Reflected DEF debuff');});},
    toshFirewall: f => {for(const p of party){eq(p.status.firewall,1,'Firewall duration');const hp=p.hp;applyDamageToAlly(p,300);eq(p.hp,hp,'Firewall blocks damage');ok(!inflictBurn(p),'Firewall blocks Burn');}},
    toshTeamplayer: follow,
    toshCheatcodePlus: f => {heal(f);party.forEach(p=>{eq(p.status.spdUp,3,'SPD buff duration');eq(dodgeOf(p),Math.min(.95,p.dodge*1.5),'Effective 1.5x speed');});},
    toshMydoom: damage
  };
  function damage(f) {
    for (const e of affected(f)) {
      const before=f.before.enemies.find(b=>b.name===e.name);
      ok(e.hp < before.hp, `${f.skill.name} damages ${e.name}`);
    }
    if(f.skill.target==='enemy')for(const e of enemies.filter(e=>e!==f.target))eq(e.hp,f.before.enemies.find(b=>b.name===e.name).hp,'Single-target skill leaves other enemies unchanged');
  }
  function heal() { party.filter(p=>p.alive).forEach(p=>eq(p.hp,p.maxHP,'Living ally fully healed')); }
  function taunting(f) {eq(taunt.targetName,f.user.name,'Taunt targets caster');eq(taunt.turns,1,'Taunt duration');ok(exclusiveThisPlayerPhase.tauntUsed,'One taunt per phase');}
  function follow(f) {for(const p of party){const eligible=['Niko Himura','Towa Himura','Toshiro Yoshikawa'].includes(p.name);eq(p.status.followBoost||0,eligible?6:0,`${p.name}: follow-up eligibility and duration`);}}

  const passives = {
    notyet: f => {applyDamageToAlly(f.user,f.user.hp+1);eq(f.user.hp,1,'First lethal hit leaves 1 HP');applyDamageToAlly(f.user,2);eq(f.user.hp,0,'Second lethal hit is not prevented');},
    faceit: f => {const foe=enemies[0];foe.baseAcc=1;f.user.dodge=0;f.user._faceItTurns=3;randomValue=.8;ok(!hitCheck(foe,f.user),'Face It reduces hit chance');f.user._faceItTurns=0;ok(hitCheck(foe,f.user),'Accuracy returns after passive expires');},
    efficiency: f => {randomValue=.149;let c=efficiencyAdjustedCosts(41,87);eq(c.cost,20,'Efficiency halves EN, rounded down');eq(c.hpCost,43,'Efficiency halves HP, rounded down');randomValue=.15;c=efficiencyAdjustedCosts(41,87);eq(c.cost,41,'Efficiency does not proc at 15% threshold');eq(c.hpCost,87,'Unmodified HP outside proc');},
    hackerShield: f => {const foe=enemies[0];_currentEnemyAttacker=foe;const hp=f.user.hp;applyDamageToAlly(f.user,300);eq(f.user.hp,hp,'Shield prevents incoming damage');eq(foe.hp,foe.maxHP-300,'Damage reflected');eq(f.user.status.reflectAll,3,'Shield starts with three turns');},
    lastStand: f => {f.user.status.reflectAll=0;applyDamageToAlly(f.user,f.user.hp+1);eq(f.user.hp,1,'Last Stand leaves 1 HP');applyDamageToAlly(f.user,2);eq(f.user.hp,0,'Last Stand only once');},
    gladiator: f => {const hp=f.user.hp;eq(f.user.status.shieldHP,1000,'Shield starts at 1000');applyDamageToAlly(f.user,400);eq(f.user.hp,hp,'Shield absorbs first hit');eq(f.user.status.shieldHP,600,'Shield remaining');applyDamageToAlly(f.user,800);eq(f.user.hp,hp-200,'Overflow damages HP');eq(f.user.status.shieldHP,0,'Shield depleted');ok(inflictBurn(f.user),'Shield does not block ailments');},
    angryHome: f => {const normal=atkOf(f.user);f.user.status.rage=1;eq(atkOf(f.user),normal*2,'Rage doubles attack');},
    surprise: f => {f.user.surpriseReady=true;eq(consumeSurpriseIfActive(f.user),2,'Surprise doubles attack');eq(consumeSurpriseIfActive(f.user),1,'No second use');eq(f.user.surpriseCounter,10,'Ten-turn cooldown');for(let i=0;i<9;i++){f.user._turnStarted=false;tickAllyTurnStart(f.user);}ok(!f.user.surpriseReady,'Not ready after nine turns');f.user._turnStarted=false;tickAllyTurnStart(f.user);ok(f.user.surpriseReady,'Ready after ten turns');},
    husk: f => {ok(!inflictBurn(f.user),'Husk blocks Burn');ok(!inflictStun(f.user),'Husk blocks stun');for(const k of ['brainwash','rage','despair'])ok(!setExclusiveAilment(f.user,k,2,true),'Husk blocks '+k);},
    loversSpecial: f => {const niko=party.find(p=>p.name==='Niko Himura');niko._nikoNotYetUsed=true;applyDamageToAlly(niko,niko.hp+1);eq(niko.hp,1,'Akio prevents lethal hit on Niko');ok(!f.user._loversSpecialAvailable,'Protective Lookout consumed');applyDamageToAlly(niko,2);eq(niko.hp,0,'Lookout only once');},
    akioZen: f => {ok(!inflictBurn(f.user),'Zen blocks Burn');ok(!setExclusiveAilment(f.user,'rage',2,true),'Zen blocks Rage');ok(!setExclusiveAilment(f.user,'despair',2,true),'Zen blocks Despair');ok(setExclusiveAilment(f.user,'brainwash',2,true),'Zen does not block Brainwash');},
    everMentorship: f => {const evaluate=key=>{const v=fixture('Miya Hagimoto',key);cast(v);return v.before.enemies[0].hp-enemies[0].hp;};const boostedMalware=evaluate('malware');party.find(p=>p.name==='Toshiro Yoshikawa').alive=false;const plain=fixture('Miya Hagimoto','malware');party.find(p=>p.name==='Toshiro Yoshikawa').alive=false;cast(plain);ok(boostedMalware>plain.before.enemies[0].hp-enemies[0].hp,'Mentorship increases Malware damage');const boostedRansom=evaluate('ransom');const r=fixture('Miya Hagimoto','ransom');party.find(p=>p.name==='Toshiro Yoshikawa').alive=false;cast(r);ok(boostedRansom>r.before.enemies[0].hp-enemies[0].hp,'Mentorship increases Ransomware damage');},
    betterOdds: f => {randomValue=.52;const sk=byKey.get('toshUltimateAilment');useSkill(sk);ok(enemies.every(e=>['brainwash','rage','despair'].some(k=>e.status[k]>0)),'Better Odds succeeds at 52%, beyond base 50%');},
    cutIn: f => {randomValue=.009;ok(tryToshiroCutIn(),'Cut In triggers below 1%');randomValue=.01;ok(!tryToshiroCutIn(),'Cut In does not trigger at 1%');}
  };

  async function runAll() {
    for (const skill of catalog) {
      const character=skill.character;
      covered.add(character+'::'+skill.key);
      await check(character,skill.name,'catalog coverage',()=>ok((skill.passive?passives:effects)[skill.key],`No explicit behavioral test for new skill ${skill.key}`));
      if (skill.passive) {
        await check(character,skill.name,'passive trigger and limits',()=>{const f=fixture(character,skill.key);if(!passives[skill.key])fail('Missing passive test');passives[skill.key](f);});
        continue;
      }
      await check(character,skill.name,'effect, exact cost, one action',()=>{
        const f=fixture(character,skill.key);cast(f);
        eq(f.user.en,f.en-(skill.cost||0),'EN charged exactly once');
        if(skill.hpCost)eq(f.user.hp,f.hp-skill.hpCost,'HP charged exactly once');
        if(skill.kind!=='mimic')eq(advances,1,'Consumes exactly one action');
        effects[skill.key]?.(f);
      });
      if(skill.cost>0)await check(character,skill.name,'insufficient energy leaves state unchanged',()=>{
        const f=fixture(character,skill.key);f.user.en=0;const before=copy({party,enemies});cast(f);
        eq(advances,0,'No action consumed');same({party,enemies},before,'No effects or partial costs');
      });
      if(skill.hpCost>0)await check(character,skill.name,'cannot spend lethal HP cost',()=>{
        const f=fixture(character,skill.key);f.user.hp=skill.hpCost;const before=copy({party,enemies});cast(f);
        eq(advances,0,'No action consumed');same({party,enemies},before,'HP gate leaves state unchanged');
      });
      if(['enemy','ally'].includes(skill.target))await check(character,skill.name,'target selection does not charge early',()=>{
        const f=fixture(character,skill.key);useSkill(f.skill,null);eq(advances,0,'No action before target selected');eq(f.user.en,f.en,'No EN before selecting target');eq(f.user.hp,f.hp,'No HP before selecting target');ok(pendingSkill,'Skill remains pending target selection');
      });
      if(statusCases[skill.key])for(const [roll,applied] of [[.2,true],[.8,false]])await check(character,skill.name,`chance branch ${applied?'success':'failure'}`,()=>{
        const f=fixture(character,skill.key,{random:roll});cast(f);affected(f).filter(e=>!(statusCases[skill.key]==='burn'&&isSS(e))).forEach(e=>expectStatus(e,statusCases[skill.key],applied));
      });
      if((skill.target==='allEnemies' && skill.key!=='riskit') || ['honor','haveMercy','toshUltimateHack','toshCheatback'].includes(skill.key))await check(character,skill.name,'observer remains immune while summons live',()=>{
        const f=fixture(character,skill.key,{observer:true});const ss=enemies[0], before=copy(ss);cast(f);
        eq(ss.hp,before.hp,'Observer takes no damage');eq(ss.en,before.en,'Observer loses no EN');same(ss.status,before.status,'Observer statuses unchanged');
      });
    }
    await specialCases();
    await mimicCases();
    await enemyCases();
    Math.random=realRandom;
    return { catalog, results, covered: [...covered], scope: 'Every current playable skill/passive, all copied Mimic skills, enemy action handlers, and targeted interaction/edge cases. Effects execute in the real patched engine; presentation and turn scheduling are isolated.' };
  }
  async function specialCases() {
    for(const key of ['gloom','towaVengeance','akioDream','akioPositive','toshUltimateAilment','allbark','onearmy'])await check(byKey.get(key).character,byKey.get(key).name,'immune boss is not falsely logged as afflicted',()=>{
      const f=fixture(byKey.get(key).character,key);_postSummonsDialogueDone=true;const ss=enemies.find(isSS);ss._analytical={active:true,current:'IMMUNE_AIL',phaseCounter:0};f.target=ss;
      cast(f);ok(!messages.some(line=>line.includes(ss.name)&&/is afflicted|is enraged|is shaken|is confused/.test(line)),'Combat log only announces successful status effects');
    });
    const statusAttempts = [
      ['Burn',p=>inflictBurn(p,2)], ['stun',p=>inflictStun(p,2)], ['Crash',p=>applyCrash(p)],
      ...['brainwash','rage','despair'].map(key=>[key,p=>setExclusiveAilment(p,key,2,true)]),
      ...['atkDown','defDown','accDown','accWeaken','spdWeaken','defCrash'].map(key=>[key,p=>addTurns(p,key,2)])
    ];
    for(const [name,attempt] of statusAttempts)await check('Toshiro Yoshikawa','Firewall','blocks '+name+' through all status entry points',()=>{
      const f=fixture('Toshiro Yoshikawa','toshFirewall');cast(f);
      const protectedAlly=party.find(p=>p.name==='Niko Himura');const before=copy(protectedAlly);
      attempt(protectedAlly);same(protectedAlly,before,'Firewall prevents the entire harmful effect');
    });
    await check('Toshiro Yoshikawa','Firewall','allows friendly buffs and healing',()=>{
      const f=fixture('Toshiro Yoshikawa','toshFirewall');cast(f);
      addTurns(f.user,'atkUp',3);addTurns(f.user,'defUp',3);addTurns(f.user,'spdUp',3);
      eq(f.user.status.atkUp,3,'Friendly ATK buff allowed');eq(f.user.status.defUp,3,'Friendly DEF buff allowed');eq(f.user.status.spdUp,3,'Friendly speed buff allowed');
      const healing=byKey.get('toshCheatcodePlus');party[1].hp=100;useSkill(healing);eq(party[1].hp,party[1].maxHP,'Friendly healing allowed');
    });
    for(const [name,attempt] of statusAttempts)await check('Miya Hagimoto',"Hacker's Shield",'reflects '+name+' through direct and generic helpers',()=>{
      const f=fixture('Miya Hagimoto','hackerShield');const attacker=enemies[0];_currentEnemyAttacker=attacker;ENEMY_LOG=true;
      const before=copy(f.user);attempt(f.user);same(f.user,before,'Caster remains protected');
      if(name==='stun')eq(attacker.stunTurns,2,'Attacker receives stun');
      else if(name==='Crash'){eq(attacker.stunTurns,1,'Attacker receives Crash stun');eq(attacker.status.defDown,1,'Attacker receives Crash DEF down');}
      else eq(attacker.status[name==='Burn'?'burn':name],2,'Attacker receives reflected status');
    });
    await check('Miya Hagimoto',"Hacker's Shield",'Firewall absorbs status before reflection',()=>{
      const f=fixture('Miya Hagimoto','hackerShield');f.user.status.firewall=1;const attacker=enemies[0];_currentEnemyAttacker=attacker;
      inflictStun(f.user,1);eq(f.user.stunTurns,0,'Caster protected');eq(attacker.stunTurns,0,'No reflection when Firewall absorbs');
    });
    for(const [name,attempt]of statusAttempts.slice(0,6))await check('Soulless Survivor','Analytical Thinking: IMMUNE_AIL','blocks '+name+' through direct helpers',()=>{
      fixture('Niko Himura','gloom');_postSummonsDialogueDone=true;const ss=enemies.find(isSS);ss._analytical={active:true,current:'IMMUNE_AIL',phaseCounter:0};
      const before=copy(ss);attempt(ss);same(ss,before,'Boss stays free of the ailment');
    });
    for(const key of ['allbark','onearmy','akioExplode','akioPositive'])await check(byKey.get(key).character,byKey.get(key).name,'boss ailment immunity does not cancel physical damage',()=>{
      const f=fixture(byKey.get(key).character,key);_postSummonsDialogueDone=true;const ss=enemies.find(isSS);ss._analytical={active:true,current:'IMMUNE_AIL',phaseCounter:0};
      f.target=ss;cast(f);ok(ss.hp<ss.maxHP,'Boss still takes attack damage');
      for(const k of ['brainwash','rage','despair','burn'])eq(ss.status[k]||0,0,'Boss immunity blocks '+k);
    });
    await check('Niko Himura','Reflected damage','uses normal survival and protection effects',()=>{
      const f=fixture('Niko Himura','gloom');reflectSkillDamage(f.user,f.user.hp+1);eq(f.user.hp,1,'Not Yet prevents reflected lethal damage');
      f.user.status.firewall=1;reflectSkillDamage(f.user,100);eq(f.user.hp,1,'Firewall blocks reflected damage');
    });
    for(const key of damageKeys)for(const [buff,multiplier]of [['teamTriple',3],['teamDouble',2]])await check(byKey.get(key).character,byKey.get(key).name,`${multiplier}x team buff covers every target and consumes one charge`,()=>{
      const skill=byKey.get(key), plain=fixture(skill.character,key);cast(plain);
      const damages=affected(plain).map(e=>({name:e.name,damage:plain.before.enemies.find(b=>b.name===e.name).hp-e.hp}));
      const boosted=fixture(skill.character,key);boosted.user.status[buff]=1;cast(boosted);
      for(const expected of damages){const target=enemies.find(e=>e.name===expected.name);const initial=boosted.before.enemies.find(e=>e.name===expected.name).hp;eq(initial-target.hp,expected.damage*multiplier,`All targets receive ${multiplier}x damage (${target.name})`);}
      eq(boosted.user.status[buff],0,'Only one buff charge consumed for the action');
    });
    for(const source of availableMimicSources())await check('Akio Mamoru','Mimic: '+source.name,'menu lists every active skill and excludes passives',()=>{
      const f=fixture('Akio Mamoru','akioMimic');renderMimicSkillMenu(f.user,source);
      const labels=[...UI.subMenu.querySelectorAll('button strong')].map(node=>node.textContent);
      for(const skill of source.list)if(skill.passive)ok(!labels.includes(skill.name),'Passive not offered: '+skill.name);else if(skill.kind!=='mimic')ok(labels.includes(skill.name),'Active skill offered: '+skill.name);
      eq(advances,0,'Browsing Mimic does not consume turn');eq(f.user.en,f.en,'Browsing Mimic costs no EN');
    });
    for(const [character,key,status] of [['Niko Himura','faceit','_faceItTurns'],['Miya Hagimoto','hackerShield','reflectAll']])await check(character,byKey.get(key).name,'active for all three advertised opening turns',()=>{
      const f=fixture(character,key);
      for(let turn=1;turn<=3;turn++){f.user._turnStarted=false;tickAllyTurnStart(f.user);ok((status==='reflectAll'?f.user.status[status]:f.user[status])>0,`Passive remains active during opening turn ${turn}`);}
      f.user._turnStarted=false;tickAllyTurnStart(f.user);eq(status==='reflectAll'?f.user.status[status]:f.user[status],0,'Passive expires after opening turns');
    });
    await check('Miya Hagimoto',"Hacker's Shield",'reflects enemy stun as well as damage',()=>{
      const f=fixture('Miya Hagimoto','hackerShield');const attacker=enemies[0];_currentEnemyAttacker=attacker;ENEMY_LOG=true;
      inflictStun(f.user,1);eq(f.user.stunTurns,0,'Miya is not stunned through Reflect');eq(attacker.stunTurns,1,'Stun is reflected to attacker');
    });
    for(const key of ['cutting','homerun'])for(const [roll,critical]of [[.2,true],[.8,false]])await check(byKey.get(key).character,byKey.get(key).name,`critical branch ${critical?'success':'failure'}`,()=>{
      const f=fixture(byKey.get(key).character,key,{random:roll});cast(f);affected(f).forEach(e=>eq(e.stunTurns>0,critical,'Critical hit stuns exactly on success branch'));
    });
    for(const [mode,key]of [['IMMUNE_AIL','gloom'],['SPAWN_ON_HEAL','cheatcode']])await check('Soulless Survivor','Analytical Thinking: '+mode,'real interaction with player skill',()=>{
      const f=fixture(byKey.get(key).character,key);_postSummonsDialogueDone=true;const ss=enemies.find(isSS);ss._analytical={active:true,current:mode,phaseCounter:0};
      cast(f);
      if(mode==='IMMUNE_AIL')eq(ss.status.despair||0,0,'Analytical immunity prevents Despair on the boss');
      else eq(enemies.length,f.before.enemies.length+4,'Healing reaction spawns four enemies');
    });
    await check('Soulless Survivor','Analytical Thinking: REPEL_BASIC','basic attack reflection',()=>{
      const f=fixture('Niko Himura','gloom');_postSummonsDialogueDone=true;const ss=enemies.find(isSS);ss._analytical={active:true,current:'REPEL_BASIC',phaseCounter:0};
      selectedAction='attack';_pickCtx={action:'attack'};const hp=f.user.hp;onTargetChosen('enemy',enemies.indexOf(ss));
      ok(f.user.hp<hp,'Basic attack reflected onto caster');eq(ss.hp,ss.maxHP,'Boss takes no reflected attack damage');
    });
    await check('Soulless Survivor','Focus','triple attack consumes focus once',()=>{
      fixture('Niko Himura','gloom');const ss=enemies.find(isSS);ss._focusReady=true;
      eq(burstInfo(ss,'single').repeat,3,'Focused attack hits three times');eq(burstInfo(ss,'single').repeat,1,'Following attack is unboosted');
    });
    for(const character of ['Soulless Survivor','Itachi Himura','Dr. Hirose Yuki','Test Subject'])await check(character,'Syringe','restores 1000 EN to each enemy, capped at maximum',()=>{
      fixture('Niko Himura','gloom');const foe=character==='Test Subject'?createTestSubject('Syringe'):enemy(character);enemies=[foe,enemy('Companion')];
      enemies[0].en=0;enemies[1].en=enemies[1].maxEN-200;enemyUseSyringe(foe);
      eq(foe.en,Math.min(1000,foe.maxEN),'Caster energy restoration');eq(enemies[1].en,enemies[1].maxEN,'Companion capped at max EN');
    });
    await check('Niko Himura','Risk it?','once per battle',()=>{const f=fixture('Niko Himura','riskit');cast(f);advances=0;const before=copy({party,enemies});cast(f);same({party,enemies},before,'Second cast blocked without costs');eq(advances,0,'No second action');});
    await check('Niko Himura','Risk it?','unavailable outside opening phase',()=>{const f=fixture('Niko Himura','riskit');enemies.find(e=>e.name==='Dr. Hirose Yuki').alive=false;const before=copy({party,enemies});cast(f);same({party,enemies},before,'Phase gate checked before costs');eq(advances,0,'No action');});
    await check('Towa Himura','Honor Code','no buffs means no costs',()=>{const f=fixture('Towa Himura','honor');for(const e of enemies)for(const k of ['atkUp','defUp','spdUp','accUp'])e.status[k]=0;cast(f);eq(f.user.en,f.en,'No wasted EN');eq(advances,0,'No action');});
    await check('Miya Hagimoto','Uber Hacker','rejects one-action enemy',()=>{const f=fixture('Miya Hagimoto','uber');f.target=enemies[0];f.target._customAI='testSubject';f.target._deferUntilPhase=-1;cast(f);eq(f.user.en,f.en,'Ineligible target costs no EN');eq(advances,0,'No action');});
    for(const key of ['damsel','tsundere','akioJester'])await check(byKey.get(key).character,byKey.get(key).name,'one taunt per player phase',()=>{const f=fixture(byKey.get(key).character,key);exclusiveThisPlayerPhase.tauntUsed=true;cast(f);eq(f.user.en,f.en,'Repeated taunt costs no EN');eq(advances,0,'No action');});
    for(const key of ['dontbottle','trueSide','akioBack','headache','toshMydoom'])await check(byKey.get(key).character,byKey.get(key).name,'documented insane damage multiplier',()=>{
      const f=fixture(byKey.get(key).character,key,{random:.8});cast(f);const e=f.target;
      const attack=f.user.baseAtk+50, defence=e.baseDef, expected=Math.round((attack*2.4-defence)*1.18);
      eq(f.before.enemies[0].hp-e.hp,expected,'Insane damage uses 2.4× attack before defense, with controlled +18% spread');
    });
    for(const key of ['malware','ransom','toshMydoom','allbark','onearmy'])await check(byKey.get(key).character,byKey.get(key).name,'analytical reflection damages caster',()=>{
      const f=fixture(byKey.get(key).character,key);const ss=enemies.find(isSS);_postSummonsDialogueDone=true;ss._analytical={active:true,current:['allbark','onearmy'].includes(key)?'REPEL_DREAD':'REPEL_CRASH',phaseCounter:0};
      const before=f.user.hp+(f.user.status.shieldHP||0);cast(f);
      ok(f.user.hp+(f.user.status.shieldHP||0)<before-(f.skill.hpCost||0),'Reflected attack reduces caster HP or shield, in addition to HP cost');
      eq(f.user.baseAtk,f.before.party[0].baseAtk,'Reflected skill restores temporary attack override');
    });
  }
  async function mimicCases() {
    for(const source of availableMimicSources())for(const skill of source.list.filter(s=>!s.passive&&s.kind!=='mimic')) {
      await check('Akio Mamoru',`Mimic → ${source.name}: ${skill.name}`,'copied skill effect and exactly one cost',()=>{
        const f=fixture('Akio Mamoru',skill.key);const originalSkill=byKey.get(skill.key);
        f.skill=skill;
        // Give copied Risk it? and healing/revive skills the same legal preconditions.
        if(skill.key==='eye'){f.target=party.find(p=>p!==f.user);f.target.alive=false;f.target.hp=0;f.target.en=0;}
        if(skill.key==='riskit')f.target=enemies.find(e=>e.name==='Itachi Himura');
        const user=f.user, en=user.en, hp=user.hp;
        executeMimickedSkill(user,skill);
        if(pendingSkill) { const target=skill.target==='ally'?f.target:(f.target||enemies[0]);onTargetChosen(skill.target==='ally'?'ally':'enemy',(skill.target==='ally'?party:enemies).indexOf(target)); }
        eq(user.en,en-(skill.cost||0),'Akio pays copied EN cost once');
        if(skill.hpCost)eq(user.hp,hp-skill.hpCost,'Akio pays copied HP cost once');
        eq(advances,1,'Copied skill consumes exactly one action');
        if(originalSkill && effects[skill.key])effects[skill.key](f);else fail('Copied skill has no effect assertion');
      });
    }
  }
  async function enemyCases() {
    const actions={
      medkit:'Soulless Survivor',trial1:'Soulless Survivor',trial2:'Soulless Survivor',null:'Soulless Survivor',charge:'Soulless Survivor',focus:'Soulless Survivor',systemRestore:'Soulless Survivor',systemRestorePlus:'Soulless Survivor',mind:'Soulless Survivor',single:'Soulless Survivor',aoe:'Soulless Survivor',explosiveCat:'Soulless Survivor',
      itachiMind:'Itachi Himura',itachiMemento:'Itachi Himura',itachiWill:'Itachi Himura',itachiSerum:'Itachi Himura',yukiCheers:'Dr. Hirose Yuki',yukiGrief:'Dr. Hirose Yuki',yukiUndying:'Dr. Hirose Yuki'
    };
    const expectedCosts={medkit:30,trial1:20,trial2:20,null:10,focus:50,systemRestore:20,systemRestorePlus:20,mind:40,itachiMind:30,itachiMemento:50,itachiWill:200,yukiCheers:30,yukiGrief:50};
    for(const [action,character]of Object.entries(actions))await check(character,action,'real enemy action handler and cost',async()=>{
      fixture('Niko Himura','gloom');
      party=['Niko Himura','Miya Hagimoto','Hotaru Minami','Toshiro Yoshikawa'].map(name=>{const p=buildStatsFromTiers(name,normalizeTiers(ROSTER[name]));p.hp=p.maxHP=10000;p.en=p.maxEN=10000;p._turnStarted=true;p._toshiroCutIn=false;p.status.reflectAll=0;p.status.shieldHP=0;return p;});
      const foe=enemy(character);foe.hp=95000;foe.en=5000;
      const companion=enemy('Allied Enemy');companion._summonedBySS=true;companion.hp=95000;companion.en=5000;
      enemies=character==='Soulless Survivor'?[foe,companion]:[foe,enemy('Soulless Survivor'),companion];
      if(character!=='Soulless Survivor'){enemies[1].hp=95000;enemies[1].en=5000;}
      if(action==='null'){foe.status.atkDown=3;foe._ailProb.atkDown=0;}
      if(action.startsWith('systemRestore')){party[1].status.despair=2;party[2].status.defDown=3;party[2].stunTurns=2;}
      const before=copy({party,enemies}); phase='enemy';_inPlayerPhase=false;enemyPhaseCounter=1;SS_FOCUS_CHANCE_LAST_ACTION=0;
      actionsForEnemy=e=>e===foe?1:0; chooseBossAction=()=>action;ssTryMoreVictims=()=>false;
      try{await originalEnemyPhase();}finally{actionsForEnemy=originalActionsForEnemy;chooseBossAction=originalChooseBossAction;ssTryMoreVictims=originalMoreVictims;}
      const old=before.enemies[0];eq(foe.en,old.en-(expectedCosts[action]||0)+(action==='itachiSerum'?150:0),'Enemy EN cost');
      if(['single','aoe','explosiveCat'].includes(action))ok(party.some((p,i)=>p.hp<before.party[i].hp),'Attack damages player party');
      if(action==='trial1')party.forEach(p=>eq(p.status.atkDown,3,'Trial 1 ATK down'));
      if(action==='trial2')party.forEach(p=>eq(p.status.defDown,3,'Trial 2 DEF down'));
      if(action==='medkit')eq(foe.hp,old.hp+1000,'Medkit heals 1000 HP');
      if(action==='null')eq(foe.status.atkDown,0,'Null clears debuff');
      if(action==='charge')eq(foe._chargeWindow,3,'Charge arms four actions and consumes current action window');
      if(action==='focus')ok(foe._focusArmed,'Focus armed for next phase');
      if(action.startsWith('systemRestore')){eq(party[1].status.despair,0,'Restore clears Despair');eq(party[2].status.defDown,0,'Restore clears Crash DEF');eq(party[2].stunTurns,0,'Restore clears stun');if(action==='systemRestorePlus')eq(foe.hp,old.hp+2000,'Restore+ heals 2000 HP');}
      if(action==='mind'||action==='itachiMemento')ok(party.some(p=>p.stunTurns>0),'Mind control applies stun');
      if(action==='itachiMind')ok(party.some(p=>p.status.brainwash>0),'Mindgames applies Brainwash');
      if(action==='itachiWill')eq(companion.hp,95500,'Will heals allies by 500');
      if(action==='itachiSerum'){eq(foe.hp,old.hp-250,'Serum costs 250 HP');eq(companion.en,5150,'Serum gives allies 150 EN');}
      if(action==='yukiCheers')for(const k of ['atkUp','defUp','accUp','spdUp'])eq(companion.status[k],2,'Cheers '+k+' after companion turn-start upkeep');
      if(action==='yukiGrief')ok(party.some(p=>p.status.rage>0),'Grief inflicts Rage');
      if(action==='yukiUndying'){eq(foe.hp,old.hp-500,'Undying costs 500 HP');eq(companion.hp,95500,'Undying heals another enemy');}
    });
    await check('Soulless Survivor','More Victims!','four subjects, exact cost and next-phase activation',()=>{fixture('Niko Himura','gloom');const ss=enemies.find(isSS);randomValue=.01;const before=ss.en;ok(ssTryMoreVictims(ss),'Summon succeeds');eq(ss.en,before-30,'Summon costs 30 EN');const pack=enemies.filter(e=>e._customAI==='testSubject');eq(pack.length,4,'Four subjects');pack.forEach(e=>{eq(originalActionsForEnemy(e),0,'Cannot act in summoning phase');});enemyPhaseCounter++;pack.forEach(e=>ok(originalActionsForEnemy(e)>0,'Can act in next phase'));});
    await check('Soulless Survivor','Reincarnation','summons both named allies and charges 40 EN once',()=>{fixture('Niko Himura','gloom');const ss=enemies.find(isSS);enemies=[ss];const en=ss.en;doReincarnation(ss);eq(ss.en,en-40,'Reincarnation costs 40 EN');ok(enemies.some(e=>e.name==='Itachi Himura')&&enemies.some(e=>e.name==='Dr. Hirose Yuki'),'Both summons present');doReincarnation(ss);eq(enemies.length,3,'Cannot duplicate summons');eq(ss.en,en-40,'No second charge');});
    for(const mode of ['Forced Gratitude','Basic Attack','AntiSOS'])await check('Test Subject',mode,'real custom AI effect and cost',()=>{
      fixture('Niko Himura','gloom');party.forEach(p=>{p.status.reflectAll=0;p.status.shieldHP=0;});const ss=enemies.find(isSS);ss.hp-=1000;const subject=createTestSubject('Test');subject.en=512;subject.baseAcc=2;enemies.push(subject);const before=copy({party,hp:ss.hp});
      const randoms=mode==='Forced Gratitude'?[.2]:mode==='Basic Attack'?[.5]:[.8];let i=0;Math.random=()=>randoms[i++]??.2;
      testSubjectTakeAction(subject);eq(subject.en,mode==='Forced Gratitude'?482:mode==='AntiSOS'?494:512,'Subject EN cost');
      if(mode==='Forced Gratitude')eq(ss.hp,before.hp+500,'Gratitude heals SS by 500');else ok(party.some((p,i)=>p.hp<before.party[i].hp),'Subject damages party');
    });
    return Object.keys(actions);
  }
  window.__allSkillTests={runAll,catalog};
}

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const anchor = '\n})();\n\n// === global error fallbacks ===';
if (!html.includes(anchor)) throw Error('Cannot find the game closure. Update the test injection anchor; no tests ran.');
const testHtml = html.replace(anchor, `\n(${installSkillHarness.toString()})();\n${anchor}`);
const reportDirectory = resolve(process.env.RPG_SKILL_REPORT_DIR || resolve(root,'test-results'));
const profile = await mkdtemp(resolve(tmpdir(),'rpg-skill-tests-'));
let browserProcess, browser, page, server;
const errors = [];

try {
  server=createServer(async(req,res)=>{
    try {
      const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(name==='/'){res.setHeader('Content-Type','text/html');return res.end(testHtml);}
      if(name==='/save-system.js'){res.setHeader('Content-Type','text/javascript');return res.end('window.RpgSaves=new Proxy({}, {get:()=>()=>{}});');}
      if(name.startsWith('/api/')){res.writeHead(403);return res.end('Tests cannot access save APIs');}
      const path=resolve(root,'.'+name);
      if(!path.startsWith(root+sep))throw Error('Bad path');
      res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.jfif':'image/jpeg','.webm':'video/webm','.mp3':'audio/mpeg'})[extname(path)]||'application/octet-stream');
      res.end(await readFile(path));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise((done,fail)=>{server.once('error',fail);server.listen(0,'127.0.0.1',done);});
  const url=`http://127.0.0.1:${server.address().port}`;
  const session=await launchTestBrowser({profile,onEvent(method,params){if(method==='Runtime.exceptionThrown')errors.push(params.exceptionDetails);}});
  browser=session.browser; page=session.page; browserProcess=session.process;
  await page.call('Runtime.enable');await page.call('Page.enable');
  // Keep external media and analytics out of deterministic mechanics tests.
  await page.call('Network.enable');if(session.selected.engine==='chromium')await page.call('Network.setBlockedURLs',{urls:['https://*','http://www.*']});
  await page.call('Page.navigate',{url});
  let loaded=false;
  for(let n=0;n<100;n++){const r=await page.call('Runtime.evaluate',{expression:'!!window.__allSkillTests',returnByValue:true});if(r.result.value){loaded=true;break;}await new Promise(done=>setTimeout(done,100));}
  if(!loaded)throw Error('Game test adapter did not initialize: '+JSON.stringify(errors));
  const response=await page.call('Runtime.evaluate',{expression:'window.__allSkillTests.runAll()',awaitPromise:true,returnByValue:true});
  if(response.exceptionDetails)throw Error('Test runner crashed: '+JSON.stringify(response.exceptionDetails));
  const report=response.result.value;
  const unknownEnemyHandlers=[...new Set([...html.matchAll(/choice === "([A-Za-z0-9]+)"/g)].map(m=>m[1]))].filter(key=>!['medkit','trial1','trial2','null','charge','focus','systemRestore','systemRestorePlus','mind','single','aoe','explosiveCat','itachiMind','itachiMemento','itachiWill','itachiSerum','yukiCheers','yukiGrief','yukiUndying'].includes(key));
  if(unknownEnemyHandlers.length)report.results.push({character:'Enemy catalog',skill:'New action handlers',scenario:'coverage',passed:false,error:'Add explicit tests for: '+unknownEnemyHandlers.join(', ')});
  for(const error of errors)report.results.push({character:'Browser',skill:'Runtime',scenario:'uncaught error',passed:false,error:JSON.stringify(error)});
  report.generatedAt=new Date().toISOString();report.failed=report.results.filter(r=>!r.passed).length;report.passed=report.results.length-report.failed;
  await mkdir(reportDirectory,{recursive:true});
  await writeFile(resolve(reportDirectory,'skills.json'),JSON.stringify(report,null,2)+'\n');
  const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const groups=[...new Set(report.results.map(r=>r.character))];
  const reportHtml=`<!doctype html><html lang="en"><meta charset="utf-8"><title>RPG skill test results</title><style>body{font:16px/1.5 system-ui;max-width:1100px;margin:32px auto;padding:0 20px;background:#101426;color:#e7e9f7}h1{font-size:28px}.pass{color:#7be5a0}.fail{color:#ff9898}details{border:1px solid #39407a;border-radius:8px;padding:12px;margin:8px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}small{opacity:.8}</style><h1>RPG skill test results</h1><p>${report.catalog.length} listed skills/passives · <span class="pass">${report.passed} passed</span> · <span class="fail">${report.failed} failed</span></p><p>${escape(report.scope)}</p><small>${escape(report.generatedAt)}</small>${groups.map(character=>{const rows=report.results.filter(r=>r.character===character);return `<h2>${escape(character)} — ${rows.filter(r=>r.passed).length}/${rows.length} passed</h2>${rows.map(r=>`<details ${r.passed?'':'open'}><summary class="${r.passed?'pass':'fail'}">${r.passed?'PASS':'FAIL'} · ${escape(r.skill)} · ${escape(r.scenario)}</summary>${r.error?`<pre>${escape(r.error)}</pre>`:'Effect assertions passed.'}${r.log?`<pre>${escape(r.log.join('\n'))}</pre>`:''}</details>`).join('')}`;}).join('')}</html>`;
  await writeFile(resolve(reportDirectory,'skills-report.html'),reportHtml);
  for(const character of groups){const rows=report.results.filter(r=>r.character===character);console.log(`${character}: ${rows.filter(r=>r.passed).length}/${rows.length} passed`);}
  for(const result of report.results.filter(r=>!r.passed))console.error(`FAIL ${result.character} / ${result.skill} / ${result.scenario}: ${result.error.split('\n')[0]}`);
  console.log(`\n${report.catalog.length} listed skills/passives; ${report.passed} passed, ${report.failed} failed.\nReport: ${resolve(reportDirectory,'skills-report.html')}\nJSON: ${resolve(reportDirectory,'skills.json')}`);
  process.exitCode=report.failed?1:0;
} catch(error) {console.error(error.stack||error);process.exitCode=1;}
finally {
  page?.socket.close();
  if(browser){try{await browser.call('Browser.close');}catch{}browser.socket.close();}
  if(browserProcess && browserProcess.exitCode===null && browserProcess.signalCode===null){browserProcess.kill();await new Promise(done=>{browserProcess.once('exit',done);setTimeout(done,3000);});}
  if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}
  await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:200}).catch(()=>{});
}

}

// ========================================================================
// testAttacks: merged from scripts/verify-attack-calculations.mjs
// ========================================================================
async function testAttacks() {
/**
 * Focused attack arithmetic and overwrite regression suite: npm run test:attacks
 * Runs the actual patched game in the system default browser. Only presentation,
 * audio and automatic turn scheduling are isolated. No production files or saves
 * are changed. Expected arithmetic is specified independently of game helpers.
 */
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const { createServer } = await import("node:http");
const { resolve, extname, sep } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { launchTestBrowser } = await import("./browser-automation.mjs");

function installAttackTests() {
  const results = [], originalRandom = Math.random;
  const baseAttack = { 'Niko Himura':300, 'Akio Mamoru':350, 'Miya Hagimoto':250, 'Towa Himura':250, 'Toshiro Yoshikawa':210, 'Hotaru Minami':420 };
  const baseDefense = { 'Niko Himura':90, 'Akio Mamoru':16, 'Miya Hagimoto':30, 'Towa Himura':85, 'Toshiro Yoshikawa':85, 'Hotaru Minami':30 };
  let roll = .8, writes = [], calculations = [], assertions = [], messages = [], advances = 0;
  const clone = value => JSON.parse(JSON.stringify(value));
  const assert = (condition, message) => { if (!condition) throw Error(message); };
  function equal(actual, expected, label) {
    if (assertions.length < 20) assertions.push({ label, expected, actual });
    assert(Object.is(actual,expected),`${label}: expected ${expected}, got ${actual}`);
  }
  const same = (actual,expected,label) => equal(JSON.stringify(actual),JSON.stringify(expected),label);
  const captureStats = unit => ({ name:unit.name,baseAtk:unit.baseAtk,atk:unit.atk,ATK:unit.ATK,baseDef:unit.baseDef,def:unit.def,DEF:unit.DEF,tiers:clone(unit.tiers||{}),atkUp:unit.status.atkUp||0,atkDown:unit.status.atkDown||0,rage:unit.status.rage||0 });
  // Independent arithmetic contract, never calling atkOf(), defOf(), or damageFormula().
  function expectedAttack(unit, tierOverride = null) {
    let attack = (tierOverride ?? unit.baseAtk) + 50 + (unit.kind==='enemy'?ENEMY_DEBUG_ATK_BONUS:0);
    if (unit.kind==='enemy' && unit.name==='Soulless Survivor' && unit._phase2) {
      if(unit.status.atkUp>0)attack*=1.5;
      attack=Math.round(attack*1.5); // Phase-2 ignores ATK down; this is the permanent 50% boost.
    } else {
      if(unit.status.atkUp>0)attack*=1.5;
      if(unit.status.atkDown>0)attack*=.7;
    }
    if(unit.name==='Hotaru Minami' && unit.status.rage>0)attack*=2;
    return Math.max(1,Math.round(attack));
  }
  function expectedDefense(unit) {
    let defense=unit.baseDef;
    if(unit.kind==='ally' && unit.status.defCrash>0)return Math.max(1,Math.round(defense*.25));
    if(unit.kind==='ally' && unit.status.defInsane>0)return 220;
    if(unit.status.defUp>0)defense*=1.5;
    if(unit.status.defDown>0)defense*=.7;
    return Math.max(1,Math.round(defense));
  }
  const expectedDamage = (attacker,defender,multiplier=1,random=roll,tier=null) => Math.max(1,Math.round(Math.max(1,expectedAttack(attacker,tier)*multiplier-expectedDefense(defender))*(.7+.6*random)));
  function watch(unit) {
    for(const field of ['baseAtk','baseDef',...(Object.hasOwn(unit,'atk')?['atk']:[])]) {
      let value=unit[field];
      Object.defineProperty(unit,field,{configurable:true,enumerable:true,get(){return value;},set(next){
        if(writes.length<80)writes.push({unit:unit.name,field,before:value,after:next,stack:new Error('Attack stat assignment').stack?.split('\n').slice(1,7).join('\n')});
        value=next;
      }});
    }
  }
  log=message=>messages.push(String(typeof message==='object'?message.text:message));
  renderBars=()=>{};renderCommandMenu=()=>{};renderSkillsMenu=()=>{};
  sayOne=()=>{};speakFollowupLines=()=>{};playSfxKey=()=>{};queueHurtFlash=()=>{};setTurnBanner=()=>{};
  swapBattleBgm=()=>{};
  advanceAfterPlayerAction=()=>{advances++;_actionInFlight=false;};
  advanceTurn=()=>{advances++;};
  const realDamageFormula=damageFormula, realDefeatHandler=handleSummonDefeatIfNeeded;
  damageFormula=function(attacker,defender,multiplier=1){
    const entry={attacker:attacker.name,defender:defender.name,baseAtk:attacker.baseAtk,effectiveAttack:atkOf(attacker),multiplier,defense:defOf(defender)};
    const damage=realDamageFormula(attacker,defender,multiplier);entry.damage=damage;calculations.push(entry);return damage;
  };
  const instrumentedDamageFormula=damageFormula;
  function keyCombo(key) {
    const event=(type,key,code,altKey)=>document.dispatchEvent(new KeyboardEvent(type,{key,code,altKey,bubbles:true}));
    event('keydown','Alt','AltLeft',true);event('keydown','a','KeyA',true);event('keydown',key,'Key'+key.toUpperCase(),true);
    event('keyup',key,'Key'+key.toUpperCase(),true);event('keyup','a','KeyA',true);event('keyup','Alt','AltLeft',false);
  }
  function debugOff() {
    if(window.debugAttackBoostEnabledV44?.())keyCombo('t');
    if(window.debugEighthAttackBoostEnabledV46?.())keyCombo('l');
  }
  function fixture(character='Niko Himura') {
    debugOff();resetBattleProgress();
    roll=.8;Math.random=()=>roll;ENEMY_DEBUG_ATK_BONUS=0;
    writes=[];calculations=[];messages=[];advances=0;
    const names=[...new Set([character,'Niko Himura','Hotaru Minami','Toshiro Yoshikawa','Miya Hagimoto'])].slice(0,4);
    party=names.map(name=>{
      const p=buildStatsFromTiers(name,normalizeTiers(ROSTER[name]));p.maxHP=p.hp=1000000;p.maxEN=p.en=1000000;p.baseAcc=2;p._turnStarted=true;
      if(name==='Hotaru Minami')p.surpriseReady=false;return p;
    });
    enemies=['Training Target A','Training Target B','Soulless Survivor'].map(name=>{
      const e=makeEnemy(name,1000000000,445,125,0,10000,'high');e.hp=e.maxHP=1000000000;
      if(name==='Soulless Survivor')e._analytical={active:false,current:null,phaseCounter:0};return e;
    });
    currentActorIdx=0;phase='player';_inPlayerPhase=true;_actedThisPhase=party.map(()=>false);
    selectedAction='skill';pendingSkill=null;_pickCtx=null;followCtx=null;
    _actionInFlight=false;_battleDialogueLockDepth=0;inSpecialDialogue=false;_inPrefightFlow=false;_currentEnemyAttacker=null;ENEMY_LOG=false;
    selectedNames=new Set(names.filter(name=>name!=='Niko Himura'));bag=defaultBag();_critCtx={active:false,seen:new Set()};
    window.__battleDialogueHardLockV72=false;window.__nikoGameOverShiftDisabledV57=false;
    UI.selectPanel.style.display='none';UI.battleUI.style.display='';UI.overlay.style.display='none';UI.menu.replaceChildren();UI.subMenu.replaceChildren();
    party.forEach(watch);enemies.forEach(watch);
    return {user:party[0],target:enemies[0]};
  }
  async function test(group,name,fn) {
    writes=[];calculations=[];messages=[];assertions=[];
    try{await fn();results.push({group,name,passed:true,assertions:clone(assertions),writes:clone(writes),calculations:clone(calculations)});}
    catch(error){results.push({group,name,passed:false,error:String(error)+(error.stack?'\n'+error.stack:''),assertions:clone(assertions),writes:clone(writes),calculations:clone(calculations),log:messages.slice(-10)});}
    finally{damageFormula=instrumentedDamageFormula;handleSummonDefeatIfNeeded=realDefeatHandler;debugOff();Math.random=originalRandom;}
  }
  const offensive=[
    ['Niko Himura','dontbottle',2.4],['Niko Himura','cutting',1],['Miya Hagimoto','trueSide',2.4],['Miya Hagimoto','malware',3.4],['Miya Hagimoto','ransom',2.4],
    ['Hotaru Minami','homerun',1,4],['Hotaru Minami','allbark',1.8,1,420],['Hotaru Minami','onearmy',2.4],['Towa Himura','headache',2.4],
    ['Akio Mamoru','akioBack',2.4],['Akio Mamoru','akioExplode',2.4],['Akio Mamoru','akioPositive',2.4],['Toshiro Yoshikawa','toshMydoom',2.4]
  ];
  const skillFor=(character,key)=>getActorSkills({name:character}).find(s=>s.key===key);
  function cast(character,key,target=enemies[0]){const skill=skillFor(character,key);assert(skill,'Missing skill '+key);useSkill(skill,skill.target==='enemy'?target:null);return skill;}
  function basic(target=enemies[0]){selectedAction='attack';_pickCtx={action:'attack'};onTargetChosen('enemy',enemies.indexOf(target));}
  async function runAll() {
    for(const character of Object.keys(baseAttack)) {
      await test('Base stats',character+' initializes from the expected attack tier',()=>{
        const {user}=fixture(character);equal(user.baseAtk,baseAttack[character],'Factory base attack');equal(atkOf(user),baseAttack[character]+50,'Global +50 applied once');
      });
      await test('Read-only calculation',character+' repeated reads do not overwrite stored stats',()=>{
        const {user,target}=fixture(character);const before=party.map(captureStats);roll=.5;
        for(let n=0;n<50;n++){equal(atkOf(user),baseAttack[character]+50,'Stable effective attack');equal(damageFormula(user,target),expectedDamage(user,target),'Stable damage');}
        same(party.map(captureStats),before,'Persistent party stats unchanged');equal(writes.length,0,'No attack/defense assignments during reads');
      });
      await test('Canonical fields',character+' ignores legacy atk/ATK shadows',()=>{
        const {user}=fixture(character);user.atk=987654;user.ATK=123456;
        equal(atkOf(user),baseAttack[character]+50,'baseAtk remains authoritative');equal(user.baseAtk,baseAttack[character],'No shadow-to-base overwrite');
        user.baseAtk=0;equal(atkOf(user),50,'Zero baseAtk does not fall back to stale atk');
      });
      for(const [up,down]of [[0,0],[3,0],[0,3],[3,3]])await test('ATK modifier precedence',`${character}: up=${up>0}, down=${down>0}`,()=>{
        const {user}=fixture(character);user.status.atkUp=up;user.status.atkDown=down;const before=captureStats(user);
        equal(atkOf(user),expectedAttack(user),'Buffs/debuffs combine instead of replacing each other');same(captureStats(user),before,'Modifiers do not rewrite base attack or durations');
      });
      for(const multiplier of [1,1.2,1.8,2.4,3.4,4])for(const random of [0,.5,.999])await test('Exact damage arithmetic',`${character}: skill x${multiplier}, random=${random}`,()=>{
        const {user,target}=fixture(character);roll=random;const before=[captureStats(user),captureStats(target)];
        equal(damageFormula(user,target,multiplier),expectedDamage(user,target,multiplier,random),'Skill multiplier, defense and ±30% spread applied in order');same([captureStats(user),captureStats(target)],before,'Arithmetic leaves stored stats unchanged');
      });
      for(const status of [{},{defUp:3},{defDown:3},{defUp:3,defDown:3},{defInsane:3,defUp:3},{defCrash:3,defInsane:3,defUp:3}])await test('Defense precedence',character+': '+(Object.keys(status).join('+')||'base'),()=>{
        const {user}=fixture(character);Object.assign(user.status,status);const before=captureStats(user);
        equal(user.baseDef,baseDefense[character],'Factory defense remains stored');equal(defOf(user),expectedDefense(user),'Crash/Insane/ordinary defense precedence');same(captureStats(user),before,'Defense calculation does not overwrite baseDef');
      });
      for(const random of [.2,.8])await test('Normal attacks',character+': exact damage and stat preservation, roll='+random,()=>{
        const {user,target}=fixture(character);roll=random;const before=party.map(captureStats),hp=target.hp,expected=expectedDamage(user,target);
        basic();equal(hp-target.hp,expected,'Basic attack damage');same(party.map(captureStats),before,'Normal attack preserves party attack stats');equal(advances,1,'One completed action');
      });
    }
    for(const [up,down]of [[0,0],[3,0],[0,3],[3,3]])await test('Rage stacking',`Hotaru: Rage with up=${up>0}, down=${down>0}`,()=>{
      const {user,target}=fixture('Hotaru Minami');user.status.rage=3;user.status.atkUp=up;user.status.atkDown=down;
      const before=captureStats(user);writes=[];
      for(let n=0;n<3;n++){
        equal(atkOf(user),expectedAttack(user),'Rage doubles the combined effective attack exactly once');
        equal(damageFormula(user,target,2.4),expectedDamage(user,target,2.4),'Skill damage retains Rage and ordinary ATK modifiers');
      }
      same(captureStats(user),before,'Repeated Rage calculations preserve base attack and status durations');equal(writes.length,0,'Rage does not assign stored attack');
    });
    await test('Minimum damage','High defense floors damage without overwriting ATK',()=>{
      const {user,target}=fixture();target.baseDef=999999;roll=0;const before=user.baseAtk;
      equal(damageFormula(user,target,1),1,'Minimum damage at unfavorable stats');equal(user.baseAtk,before,'Attack remains unchanged');
    });
    for(const up of [0,3])for(const down of [0,3])await test('Enemy phase-2 attack',`SS: up=${up>0}, down=${down>0}`,()=>{
      fixture();const ss=enemies.find(isSS);ss._phase2=true;ss.status.atkUp=up;ss.status.atkDown=down;ss.atk=777777;ss.ATK=888888;ENEMY_DEBUG_ATK_BONUS=100;
      const before=captureStats(ss);equal(atkOf(ss),expectedAttack(ss),'Permanent boss multiplier and debug bonus applied once; ATK down ignored');same(captureStats(ss),before,'No permanent rewriting or stale legacy-field reads');
    });
    for(const [character,key,multiplier,post=1,tier=null]of offensive) {
      await test('Real skill arithmetic',character+' / '+key+' repeated casts preserve attack stats',()=>{
        const {user,target}=fixture(character);const before=party.map(captureStats);
        for(let n=0;n<3;n++){
          const skill=skillFor(character,key),targets=skill.target==='enemy'?[target]:enemies;
          const hp=targets.map(t=>t.hp),expected=targets.map(t=>Math.floor(expectedDamage(user,t,multiplier,roll,tier)*post));
          cast(character,key,target);
          targets.forEach((t,i)=>equal(hp[i]-t.hp,expected[i],'Exact repeated skill damage: '+t.name));
          same(party.map(captureStats),before,'Cast does not leave an override or rewrite another actor');
        }
      });
      for(const [triple,double,mult]of [[1,0,3],[0,1,2],[1,1,5]])await test('Damage multiplier ownership',`${character} / ${key}: triple=${triple}, double=${double}`,()=>{
        const {user,target}=fixture(character);user.status.teamTriple=triple;user.status.teamDouble=double;
        party[1].status.teamTriple=2;party[1].status.teamDouble=2;
        const before=party.map(captureStats),skill=skillFor(character,key),targets=skill.target==='enemy'?[target]:enemies;
        const hp=targets.map(t=>t.hp),expected=targets.map(t=>Math.floor(expectedDamage(user,t,multiplier,roll,tier)*post)*mult);
        cast(character,key,target);targets.forEach((t,i)=>equal(hp[i]-t.hp,expected[i],'All targets retain the action multiplier: '+t.name));
        equal(user.status.teamTriple||0,0,'Caster triple consumed once');equal(user.status.teamDouble||0,0,'Caster double consumed once');
        equal(party[1].status.teamTriple,2,'Other actor triple untouched');equal(party[1].status.teamDouble,2,'Other actor double untouched');same(party.map(captureStats),before,'Base stats and ongoing ATK statuses untouched');
      });
      await test('Mimic ownership','Akio copies '+character+' / '+key+' without taking source stats permanently',()=>{
        const {user,target}=fixture('Akio Mamoru');const original=skillFor(character,key),before=party.map(captureStats),hp=target.hp;
        executeMimickedSkill(user,original);
        if(pendingSkill)onTargetChosen('enemy',0);
        assert(target.hp<hp,'Copied offensive skill actually attacked');same(party.map(captureStats),before,'Mimic restores caster and leaves source/other actors unchanged');
        assert(calculations.every(c=>c.attacker==='Akio Mamoru'),'Every copied damage calculation uses Akio as actor');
      });
    }
    for(const exit of ['hit','miss','reflection','insufficient EN','pending target','deferred defeat','defeat callback','calculation exception'])await test('Temporary override cleanup','All Bark All Bite: '+exit,()=>{
      const {user,target}=fixture('Hotaru Minami');user.baseAtk+=73;const original=user.baseAtk;writes=[];let resume, injected=false;
      if(exit==='miss')user.baseAcc=0;
      if(exit==='reflection'){_postSummonsDialogueDone=true;enemies.find(isSS)._analytical.current='REPEL_DREAD';}
      if(exit==='insufficient EN')user.en=0;
      if(exit==='deferred defeat'||exit==='defeat callback'){
        target.name='Itachi Himura';target.hp=1;target._summonedBySS=true;
        handleSummonDefeatIfNeeded=(name,done)=>{resume=done;return true;};
      }
      if(exit==='calculation exception')damageFormula=()=>{injected=true;throw Error('TEST: injected calculation failure');};
      try{cast('Hotaru Minami','allbark',exit==='pending target'?null:target);}catch(error){if(exit!=='calculation exception')throw error;}
      if(exit==='calculation exception')assert(injected,'Calculation failure was actually exercised');
      if(exit==='deferred defeat'||exit==='defeat callback')assert(typeof resume==='function','Defeat dialogue continuation was actually scheduled');
      if(exit==='defeat callback')resume();
      equal(user.baseAtk,original,'Original baseAtk restored on every exit path');
      if(['insufficient EN','pending target'].includes(exit))equal(writes.length,0,'Rejected/uncommitted casts do not assign baseAtk');
    });
    for(const [character,partner,chanceBonus]of [['Niko Himura','Akio Mamoru',2],['Niko Himura','Hotaru Minami',3],['Towa Himura','Hotaru Minami',3]])await test('Follow-up ownership',character+' initiates; '+partner+' supplies attack',()=>{
      fixture(character);const ally=party.find(p=>p.name===partner)||buildStatsFromTiers(partner,normalizeTiers(ROSTER[partner]));
      if(!party.includes(ally)){party[3]=ally;ally.hp=ally.maxHP=1000000;ally.baseAcc=2;ally._turnStarted=true;watch(ally);}
      ally.surpriseReady=false;ally.baseAtk+=77;party[0].baseAtk+=31;roll=.2;
      ally.status.teamTriple=1;ally.status.teamDouble=1;party[0].status.teamTriple=2;
      const before=party.map(captureStats),hp=enemies[0].hp;
      followCtx={initiatorIdx:0,partnerIdx:party.indexOf(ally),step:'attack'};
      const expected=expectedDamage(ally,enemies[0])*5*chanceBonus;
      performFollowAttack(0);equal(hp-enemies[0].hp,expected,'Follow-up uses partner stats and partner multipliers');same(party.map(captureStats),before,'Follow-up does not copy stats between characters');equal(party[0].status.teamTriple,2,'Initiator damage charge remains');
    });
    for(const character of Object.keys(baseAttack)){
      await test('Debug boost round trips',character+': +3300 toggles restore exact base attack',()=>{
        const {user}=fixture(character);const original=user.baseAtk;keyCombo('l');equal(user.baseAtk,original+3300,'Small debug boost applied');keyCombo('l');equal(user.baseAtk,original,'Small debug boost removed exactly');
      });
      await test('Debug boost round trips',character+': +1e20 must not erase original base attack',()=>{
        const {user}=fixture(character);const original=user.baseAtk;keyCombo('t');assert(window.debugAttackBoostEnabledV44(),'Large boost enabled through real shortcut');keyCombo('t');equal(user.baseAtk,original,'Removing huge boost restores exact base, despite floating-point precision');
      });
    }
    for(const order of [['t','l','t','l'],['l','t','l','t'],['l','t','t','l']])await test('Debug boost stacking','Toggle order '+order.join(' → '),()=>{
      const {user}=fixture('Hotaru Minami');const original=user.baseAtk;order.forEach(keyCombo);equal(user.baseAtk,original,'Stacked toggles return to original base without erasing another modifier');
    });
    await test('Debug boost stacking','Zero baseAtk does not resurrect stale legacy atk',()=>{
      const {user}=fixture();user.baseAtk=0;user.atk=9000;keyCombo('l');equal(user.baseAtk,3300,'Boost is added to authoritative zero baseAtk');
    });
    await test('Debug boost and skill override','All Bark All Bite retains an active +3300 boost during its hit',()=>{
      const {user}=fixture('Hotaru Minami');keyCombo('l');const original=user.baseAtk;cast('Hotaru Minami','allbark');
      assert(calculations.length>0,'Damage calculated');equal(calculations[0].effectiveAttack,original+50,'Temporary tier selection does not suppress a persistent attack boost');equal(user.baseAtk,original,'Persistent boost remains after cast');
    });
    for(const character of Object.keys(baseAttack))await test('Save/restore arithmetic',character+' repeated restore does not reset or compound attack modifiers',()=>{
      const {user}=fixture(character);keyCombo('l');user.status.atkUp=4;user.status.atkDown=2;user.status.teamTriple=2;user.status.teamDouble=1;
      const adapter=window.__attackSaveAdapter;assert(adapter,'Actual game save adapter captured');
      const state={...clone(adapter.snapshot()),schemaVersion:2,battleId:'attack-regression',sequence:0,turn:1};
      const saved={state,inventory:clone(adapter.inventory())},before=party.map(captureStats),attack=expectedAttack(user);
      for(let n=0;n<3;n++){adapter.restore(clone(saved));same(party.map(captureStats),before,'Restored base attack and ongoing modifiers are identical');equal(atkOf(party[0]),attack,'Restore does not double-apply debug or ATK buffs');equal(party[0].status.teamTriple,2,'Restore does not consume triple charges');}
    });
    await test('Verifier self-tests','Detects a getter that overwrites baseAtk',()=>{
      const {user}=fixture();const original=atkOf,before=user.baseAtk;let detected=false;
      try{atkOf=p=>{p.baseAtk=9999;return original(p);};atkOf(user);detected=user.baseAtk!==before&&writes.some(w=>w.field==='baseAtk');}
      finally{atkOf=original;user.baseAtk=before;}
      assert(detected,'Deliberately introduced overwrite was detected');
    });
    await test('Verifier self-tests','Independent oracle detects an overwritten damage result',()=>{
      const {user,target}=fixture();roll=.5;const expected=expectedDamage(user,target),original=damageFormula;let detected=false;
      try{damageFormula=()=>123456;detected=damageFormula(user,target)!==expected;}finally{damageFormula=original;}
      assert(detected,'Incorrect constant damage was rejected');
    });
    debugOff();Math.random=originalRandom;
    return {results,contracts:['Base attack is stored separately from effective attack; global +50 applies once.','ATK up x1.5 and ATK down x0.7 combine; Hotaru Rage adds x2.','Temporary skill overrides must restore on hit, miss, reflection, dialogue and exception exits.','Triple and double damage charges add to x5, affect the whole action, and belong to its caster.','Debug modifiers must round-trip exactly and survive temporary overrides; legacy atk must not replace baseAtk.','The real save adapter must preserve attack values and remaining modifier charges.'],scope:'Real game arithmetic and offensive action paths, with independent expected values and base-stat assignment traces. Presentation, audio and automatic turn progression are isolated.'};
  }
  window.__attackTests={runAll};
}

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),reportDir=resolve(process.env.RPG_ATTACK_REPORT_DIR||resolve(root,'test-results/attacks'));
const originalHtml=await readFile(resolve(root,'index.html'),'utf8'),anchor='\n})();\n\n// === global error fallbacks ===';
if(!originalHtml.includes(anchor))throw Error('Cannot find game closure. No attack tests ran.');
const html=originalHtml.replace(anchor,`\n(${installAttackTests.toString()})();\n${anchor}`);
let server,session;const browserErrors=[];
try{
  server=createServer(async(req,res)=>{
    try{
      const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(name==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
      if(name==='/save-system.js'){res.setHeader('Content-Type','text/javascript');return res.end('window.RpgSaves=new Proxy({}, {get:(_,key)=>key==="install"?(adapter=>window.__attackSaveAdapter=adapter):()=>{}});');}
      if(name.startsWith('/api/')){res.writeHead(403);return res.end('Save APIs are disabled in attack tests');}
      const path=resolve(root,'.'+name);if(!path.startsWith(root+sep))throw Error('Bad path');
      res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.jfif':'image/jpeg','.mp3':'audio/mpeg','.webm':'video/webm'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise((done,failed)=>{server.once('error',failed);server.listen(0,'127.0.0.1',done);});
  session=await launchTestBrowser({onEvent(method,p){if(method==='Runtime.exceptionThrown')browserErrors.push(p.exceptionDetails);}});
  await session.page.call('Runtime.enable');await session.page.call('Page.enable');
  await session.page.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  let loaded=false;
  for(let i=0;i<100;i++){const result=await session.page.call('Runtime.evaluate',{expression:'!!window.__attackTests',returnByValue:true});if(result.result?.value){loaded=true;break;}await new Promise(done=>setTimeout(done,100));}
  if(!loaded)throw Error('Attack test adapter failed to initialize: '+JSON.stringify(browserErrors));
  const result=await session.page.call('Runtime.evaluate',{expression:'window.__attackTests.runAll()',awaitPromise:true,returnByValue:true});
  if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
  const report=result.result.value;
  for(const error of browserErrors)report.results.push({group:'Browser',name:'Uncaught exception',passed:false,error:JSON.stringify(error)});
  report.generatedAt=new Date().toISOString();report.browser=session.selected.name;report.passed=report.results.filter(r=>r.passed).length;report.failed=report.results.length-report.passed;
  await mkdir(reportDir,{recursive:true});await writeFile(resolve(reportDir,'attacks.json'),JSON.stringify(report,null,2)+'\n');
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const groups=[...new Set(report.results.map(r=>r.group))];
  const page=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Attack calculations and overwrite tests</title><style>body{font:16px/1.5 system-ui;max-width:1200px;margin:30px auto;padding:0 20px;background:#101426;color:#e7e9f7}.pass{color:#7be5a0}.fail{color:#ff9898}details{border:1px solid #39407a;border-radius:8px;padding:12px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}summary{cursor:pointer}table{border-collapse:collapse}td,th{padding:6px 12px;text-align:left;border:1px solid #39407a}</style><h1>Attack calculations and overwrites</h1><p class="pass">${report.passed} passed</p><p class="fail">${report.failed} failed</p><p>${escape(report.browser)} · ${escape(report.generatedAt)}</p><p>${escape(report.scope)}</p><details><summary>Arithmetic and preservation contracts</summary><ul>${report.contracts.map(c=>`<li>${escape(c)}</li>`).join('')}</ul></details>${groups.map(group=>{const rows=report.results.filter(r=>r.group===group);return `<h2>${escape(group)} · ${rows.filter(r=>r.passed).length}/${rows.length}</h2>${rows.map(r=>`<details ${r.passed?'':'open'}><summary class="${r.passed?'pass':'fail'}">${r.passed?'PASS':'FAIL'} · ${escape(r.name)}</summary>${r.error?`<pre>${escape(r.error)}</pre>`:''}<table><tr><th>Check</th><th>Expected</th><th>Actual</th></tr>${(r.assertions||[]).map(a=>`<tr><td>${escape(a.label)}</td><td>${escape(a.expected)}</td><td>${escape(a.actual)}</td></tr>`).join('')}</table>${r.writes?.length?`<details ${r.passed?'':'open'}><summary>Attack/defense field assignments (${r.writes.length})</summary><pre>${escape(JSON.stringify(r.writes,null,2))}</pre></details>`:'<p>No stored attack/defense assignments observed.</p>'}${r.calculations?.length?`<details><summary>Damage inputs and outputs</summary><pre>${escape(JSON.stringify(r.calculations.slice(-12),null,2))}</pre></details>`:''}${r.log?.length?`<pre>${escape(r.log.join('\n'))}</pre>`:''}</details>`).join('')}`;}).join('')}</html>`;
  await writeFile(resolve(reportDir,'attacks-report.html'),page);
  for(const group of groups){const rows=report.results.filter(r=>r.group===group);console.log(`${group}: ${rows.filter(r=>r.passed).length}/${rows.length} passed`);}
  for(const test of report.results.filter(r=>!r.passed))console.error(`FAIL ${test.group} / ${test.name}: ${test.error.split('\n')[0]}`);
  console.log(`\nAttack tests: ${report.passed} passed, ${report.failed} failed.\nReport: ${resolve(reportDir,'attacks-report.html')}`);process.exitCode=report.failed?1:0;
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{if(session)await session.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}}

}

// ========================================================================
// testPhases: merged from scripts/verify-phases-dialogue.mjs
// ========================================================================
async function testPhases() {
/**
 * Phase/dialogue regression suite. Exercises real gates, dialogues, rendering,
 * turn scheduling and effects in fresh pages. Only audio and enemy pacing are
 * isolated. No save API or production database is used.
 */
const { readFile, writeFile, mkdir } = await import("node:fs/promises");
const { createServer } = await import("node:http");
const { resolve, extname, sep } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { launchTestBrowser } = await import("./browser-automation.mjs");

function installPhaseTests() {
  const cases=[], events=[], assertions=[], audio=[], saved=[];
  let roll=.99;
  const nativeTimeout=window.setTimeout.bind(window);
  const pause=ms=>new Promise(r=>nativeTimeout(r,ms));
  const assert=(ok,label)=>{assertions.push({label,actual:!!ok,expected:true});if(!ok)throw Error(label);};
  const equal=(actual,expected,label)=>{assertions.push({label,actual,expected});if(!Object.is(actual,expected))throw Error(`${label}: expected ${expected}, got ${actual}`);};
  const test=(group,name,fn)=>cases.push({group,name,fn});
  const nameOf=u=>u?.name;
  const enter=()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));
  async function acceptWarning(){
    const oldTimeout=window.setTimeout;
    // Shorten only the opening cover's two cosmetic fade delays. Use its real Yes handler.
    window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,ms===850||ms===2450?0:ms,...args);
    try{document.getElementById('introYesBtnV56')?.click();await pause(30);}
    finally{window.setTimeout=oldTimeout;}
    assert(!document.getElementById('introCoverV56'),'Opening warning accepted before fixture');
  }
  const ss=()=>enemies.find(isSS);
  const summon=name=>enemies.find(e=>e.name===name);
  const count=name=>events.filter(e=>e.name===name&&e.kind==='start').length;
  const snapshot=()=>({phase,actor:nameOf(party[currentActorIdx]),locks:_battleDialogueLockDepth,active:isBattleDialogueActive(),inFlight:_actionInFlight,acted:[..._actedThisPhase],postSummons:_postSummonsDialogueDone,hpPhase:_ssPhase2Triggered,phaseGate:!!window._ssPhase2Done,focusChance:SS_FOCUS_CHANCE_LAST_ACTION,enemies:enemies.map(e=>({name:e.name,hp:e.hp,alive:e.alive,actions:actionsForEnemy(e),phase2:!!e._phase2,atk:atkOf(e),def:defOf(e),status:{...e.status},analytical:e._analytical?{...e._analytical}:null})),party:party.map(p=>({name:p.name,hp:p.hp,turnStarted:p._turnStarted,status:{...p.status}}))});
  function wrap(name,fn) {return function(...args){events.push({name,kind:'start',phase,actor:nameOf(party[currentActorIdx])});if(typeof args.at(-1)==='function'){const done=args.at(-1);args[args.length-1]=function(...a){events.push({name,kind:'end',phase});return done(...a);};}return fn.apply(this,args);};}
  runPrefightDialogue=wrap('prefight',runPrefightDialogue);
  runSummonDialogue=wrap('summon',runSummonDialogue);
  runDefeatDialogue=wrap('defeat',runDefeatDialogue);
  runPostSummonsDialogue=wrap('postSummons',runPostSummonsDialogue);
  runSSPhase2Dialogue=wrap('hpPhase',runSSPhase2Dialogue);
  runSSZeroHPDialogue=wrap('escape',runSSZeroHPDialogue);
  swapBattleBgm=(key,options)=>audio.push({key,options});duckBGM=()=>{};playSfxKey=()=>{};queueHurtFlash=()=>{};goSilentNow=()=>{};
  sleep=()=>pause(1); // Preserve async boundaries while removing audio/animation pacing.
  Math.random=()=>roll;
  window.PREFIGHT_TYPE_SPEED=1;window.DLG_TYPE_SPEED=1;
  window.POST_TW_ENABLED=false;window.DEFEAT_TW_ENABLED=false;window.SS_PHASE2_TW_ENABLED=false;
  const originalBanner=setTurnBanner;
  setTurnBanner=function(name,kind){events.push({name:'turnBanner',kind,actor:name,dialogue:isBattleDialogueActive()});return originalBanner.apply(this,arguments);};
  const originalTick=tickAllyTurnStart;
  tickAllyTurnStart=function(unit){const before=unit?JSON.stringify(unit.status):'';const result=originalTick.apply(this,arguments);events.push({name:'turnStart',kind:'tick',actor:nameOf(unit),dialogue:isBattleDialogueActive(),before,after:unit?JSON.stringify(unit.status):'',result});return result;};
  async function drive(until,label='dialogue finishes',ms=7000) {
    const deadline=Date.now()+ms;
    while(!until()&&Date.now()<deadline){enter();await pause(3);}
    assert(until(),label+' within timeout');await pause(10);
  }
  async function resolveWithInput(promise,label){let done=false,error;Promise.resolve(promise).then(()=>done=true,e=>{error=e;done=true;});await drive(()=>done,label);if(error)throw error;}
  function fixture({summons=true,post=false,hp=35000}={}) {
    resetBattleProgress();
    party=['Toshiro Yoshikawa','Miya Hagimoto','Niko Himura','Hotaru Minami'].map(n=>buildStatsFromTiers(n,normalizeTiers(ROSTER[n])));
    party.forEach(p=>{p.hp=p.maxHP=100000;p.en=p.maxEN=100000;p._turnStarted=true;p.baseAcc=2;});
    enemies=[makeEnemy('Soulless Survivor',40000,445,225,0,2100,'high')];ss().hp=35000;ss()._analytical={active:false,current:null,phaseCounter:0};
    phase='player';_inPlayerPhase=true;_actedThisPhase=party.map(()=>false);currentActorIdx=2;
    _actionInFlight=false;_battleDialogueLockDepth=0;inSpecialDialogue=false;_inPrefightFlow=false;_pickCtx=null;followCtx=null;pendingSkill=null;selectedAction=null;
    window.__battleDialogueHardLockV72=false;window.__ssDefeatEndingStartedV89=false;window.__ssDefeatEndingStartedV92=false;
    window._ssPhase2DialoguePromiseV74=null;window.__nikoGameOverShiftDisabledV57=false;
    UI.selectPanel.style.display='none';UI.battleUI.style.display='';UI.overlay.style.display='none';UI.log.replaceChildren();bag=defaultBag();
    selectedNames=new Set(['Toshiro Yoshikawa','Miya Hagimoto','Hotaru Minami']);
    if(summons){doReincarnation(ss());enemyPhaseCounter=1;}
    _postSummonsDialogueDone=post;_itachiDefeatShown=post;_yukiDefeatShown=post;
    if(post){_defeatDlgShown['Itachi Himura']=true;_defeatDlgShown['Dr. Hirose Yuki']=true;}
    renderBars();renderCommandMenu();ss().hp=hp;events.length=0;audio.length=0;saved.length=0;assertions.length=0;
  }
  function down(name){const e=summon(name);e.hp=0;e.alive=false;}
  function buttons(){return [...UI.menu.querySelectorAll('button')].filter(b=>['Attack','Guard','Skills','Items'].includes(b.textContent.trim()));}
  function textContains(lines){const text=UI.log.textContent;for(const line of lines)assert(text.includes(line.t),`Transcript contains ${line.s}: ${line.t}`);}
  function locked(){assert(isBattleDialogueActive(),'Dialogue lock is active');assert(_actionInFlight,'Actions remain in flight');assert(buttons().length>0,'Real action buttons exist');assert(buttons().every(b=>b.disabled),'All action buttons are disabled');}
  async function hpPhase(){const p=maybeRunSSPhase2Cutscene();assert(p&&typeof p.then==='function','HP threshold schedules real dialogue');await resolveWithInput(p,'HP phase finishes');}
  test('Opening','Start Battle triggers prefight, summons, then first player turn',async()=>{
    fixture({summons:false,hp:40000});UI.startBtn.disabled=false;UI.startBtn.click();
    equal(count('prefight'),1,'Prefight begins on Start Battle');equal(count('summon'),0,'Summon dialogue waits for prefight');equal(enemies.length,1,'Summons are not created before prefight ends');
    assert(isBattleDialogueActive(),'Opening is locked');equal(saved.filter(x=>x.method==='openingFinished').length,0,'Opening checkpoint not ready early');
    await drive(()=>count('summon')===1,'Prefight hands off to summon dialogue');
    equal(summonedAliveCount(),2,'Reincarnation spawns both summons');equal(ss().en,2060,'Reincarnation costs exactly 40 EN');
    equal(saved.filter(x=>x.method==='openingFinished').length,0,'Checkpoint waits for summon dialogue');
    await drive(()=>saved.some(x=>x.method==='openingFinished'),'Opening reaches ready checkpoint');
    equal(phase,'player','Opening ends in player phase');equal(nameOf(party[currentActorIdx]),'Niko Himura','Niko takes first turn');assert(!isBattleDialogueActive(),'Opening dialogue releases lock');
    textContains(SUMMON_LINES);equal(count('prefight'),1,'Prefight runs once');equal(count('summon'),1,'Summon dialogue runs once');equal(saved.filter(x=>x.method==='openingFinished').length,1,'Exactly one opening checkpoint');
    assert(audio.some(e=>e.key==='bgm'),'Opening selects battle music');
  });
  test('Opening','Reincarnation is idempotent and respects insufficient EN',()=>{
    fixture({summons:false});ss().en=39;doReincarnation(ss());equal(enemies.length,1,'No summon below 40 EN');equal(ss().en,39,'No EN charged on rejection');
    ss().en=40;doReincarnation(ss());equal(summonedAliveCount(),2,'Summons at exact cost');equal(ss().en,0,'Exact cost charged');doReincarnation(ss());equal(enemies.length,3,'No duplicate opening summons');
  });
  for(const alive of ['both','Itachi Himura','Dr. Hirose Yuki'])test('Phase 1: observer',`Boss immunity and summon actions while ${alive} remain`,()=>{
    fixture();if(alive!=='both')down(alive==='Itachi Himura'?'Dr. Hirose Yuki':'Itachi Himura');
    assert(ssObserverActive(),'Either summon keeps boss observing');equal(actionsForEnemy(ss()),0,'Observer never acts');
    equal(hitCheck(party[0],ss()),false,'Observer cannot be hit');addTurns(ss(),'burn',3);equal(ss().status.burn||0,0,'Observer blocks statuses');
    equal(ssAnalyticalUnlocked(),false,'Analytical remains locked');
    for(const e of enemies.filter(e=>e._summonedBySS&&e.alive))equal(actionsForEnemy(e),alive==='both'?2:4,'Summon action count changes only when partner falls');
  });
  test('Phase 1: observer','Fresh summons defer to the next enemy phase',()=>{
    fixture({summons:false});doReincarnation(ss());for(const e of enemies.filter(e=>e._summonedBySS))equal(actionsForEnemy(e),0,'Fresh summon cannot act in its spawn phase');enemyPhaseCounter++;for(const e of enemies.filter(e=>e._summonedBySS))equal(actionsForEnemy(e),2,'Summon acts next phase');
  });
  for(const name of ['Itachi Himura','Dr. Hirose Yuki'])test('Summon defeats',`${name}: real dialogue, unique effect, and no repeated effect`,async()=>{
    fixture();down(name);let done=0;assert(handleSummonDefeatIfNeeded(name,()=>done++),'Defeat starts a real dialogue');locked();
    const niko=party.find(p=>p.name==='Niko Himura'),miya=party.find(p=>p.name==='Miya Hagimoto');
    equal(niko.status.despair||0,name==='Itachi Himura'?3:0,'Only Itachi triggers Niko three-turn Despair');
    equal(miya.status.atkUp||0,name==='Dr. Hirose Yuki'?6:0,'Only Yuki triggers Miya six-turn ATK up');equal(count('postSummons'),0,'One remaining summon blocks post-summons transition');
    roll=0;await drive(()=>done===1,'Defeat continuation runs');textContains(name==='Itachi Himura'?ITACHI_DEFEAT_LINES:YUKI_DEFEAT_LINES);
    const before={despair:niko.status.despair,atk:miya.status.atkUp};handleSummonDefeatIfNeeded(name,()=>{});equal(count('defeat'),1,'Duplicate defeat does not replay dialogue');equal(niko.status.despair,before.despair,'Duplicate defeat does not reapply Despair');equal(miya.status.atkUp,before.atk,'Duplicate defeat does not extend ATK up');
  });
  test('Summon defeats','Miya timed ATK boost expires without a permanent multiplier',async()=>{
    fixture();down('Dr. Hirose Yuki');handleSummonDefeatIfNeeded('Dr. Hirose Yuki',()=>{});const miya=party.find(p=>p.name==='Miya Hagimoto');await drive(()=>!isBattleDialogueActive());
    equal(miya.status.atkUp,6,'Miya keeps six turns before her own turn');const base=miya.baseAtk;
    for(let n=0;n<6;n++){miya._turnStarted=false;tickAllyTurnStart(miya);equal(miya.status.atkUp,5-n,'ATK duration ticks once on each Miya turn');}
    equal(atkOf(miya),base+50,'Normal attack restored on expiration');equal(miya.baseAtk,base,'Base ATK preserved');
  });
  test('Summon defeats','Niko forced Despair lasts exactly three of her turns',async()=>{
    fixture();currentActorIdx=0;down('Itachi Himura');handleSummonDefeatIfNeeded('Itachi Himura',()=>{});
    await drive(()=>!isBattleDialogueActive(),'Itachi defeat finishes');
    const niko=party.find(p=>p.name==='Niko Himura');
    equal(UI.log.textContent.split('is consumed by Despair').length-1,1,'First forced action occurs after defeat dialogue');equal(niko._itachiDespairTurnsV89,2,'First fresh Niko turn consumes one of three turns');
    for(let turn=2;turn<=3;turn++){
      phase='player';_inPlayerPhase=true;currentActorIdx=party.indexOf(niko);_actedThisPhase=party.map(()=>false);niko._turnStarted=false;renderCommandMenu();await pause(10);
      equal(niko._itachiDespairTurnsV89,3-turn,'One Despair turn consumed per Niko action');equal(UI.log.textContent.split('is consumed by Despair').length-1,turn,'Exactly one forced action each turn');
    }
    equal(niko.status.despair,0,'Despair clears after third turn');currentActorIdx=party.indexOf(niko);_actedThisPhase=party.map(()=>false);niko._turnStarted=false;renderCommandMenu();
    equal(nameOf(party[currentActorIdx]),'Niko Himura','Fourth Niko turn is controllable');equal(UI.log.textContent.split('is consumed by Despair').length-1,3,'No fourth forced action');
  });
  for(const order of [['Itachi Himura','Dr. Hirose Yuki'],['Dr. Hirose Yuki','Itachi Himura']])test('Post-summons transition','Sequential defeats: '+order.join(' → '),async()=>{
    fixture();roll=0;for(const name of order){down(name);handleSummonDefeatIfNeeded(name,()=>{});await drive(()=>!isBattleDialogueActive(),'Defeat chain finishes');}
    equal(count('defeat'),2,'Each summon dialogue once');equal(count('postSummons'),1,'One post-summons dialogue after both defeats');textContains(POST_SUMMONS_LINES);
    assert(ssAnalyticalUnlocked(),'Analytical unlocked after full dialogue');assert(ss()._analytical.active,'Analytical stance active');equal(actionsForEnemy(ss()),4,'Active boss gets four actions');
    equal(phase,'player','Transition yields player phase');const postEnd=events.findIndex(e=>e.name==='postSummons'&&e.kind==='end');
    equal(events.slice(postEnd+1).find(e=>e.name==='turnBanner')?.actor,'Niko Himura','Transition first resumes Niko despite party array order');
    // Itachi's forced Despair then legitimately auto-consumes Niko's fresh turn.
    assert(_actedThisPhase.every((v,i)=>!v||party[i].name==='Niko Himura'),'Only Niko forced by Despair may have acted after reset');
    assert(UI.log.textContent.includes('is consumed by Despair'),'Itachi phase effect executes only after the dialogue chain');assert(!pendingSkill&&!followCtx&&!_pickCtx,'Stale command contexts cleared');
    let continued=0;checkAndRunPostSummonsDialogueIfReady(()=>continued++);equal(count('postSummons'),1,'Repeat checks do not replay transition');
    assert(audio.some(e=>e.key==='phase2'),'Post-summons selects phase2 music');
  });
  test('Post-summons transition','Simultaneous defeats resolve Itachi, Yuki, post-summons in order',async()=>{
    fixture();roll=0;down('Itachi Himura');down('Dr. Hirose Yuki');await resolveWithInput(ensureSummonWrapupBeforeEnemyPhase(),'Simultaneous defeat wrap-up resolves');
    const starts=events.filter(e=>e.kind==='start').map(e=>e.name);equal(starts.join(','),'defeat,defeat,postSummons','Stable dialogue chain');textContains(ITACHI_DEFEAT_LINES);textContains(YUKI_DEFEAT_LINES);textContains(POST_SUMMONS_LINES);assert(!isBattleDialogueActive(),'Full chain releases lock');
    await resolveWithInput(ensureSummonWrapupBeforeEnemyPhase(),'Repeated wrap-up resolves');equal(count('postSummons'),1,'Wrap-up is idempotent');
  });
  test('Post-summons transition','No early post-summons dialogue while a summon lives',async()=>{
    fixture();down('Itachi Himura');await ensureSummonWrapupBeforeEnemyPhase();equal(count('postSummons'),0,'Wrap-up does not run early');equal(count('defeat'),0,'Wrap-up gate does not consume pending solo defeat');assert(!ssAnalyticalUnlocked(),'Analytical remains locked');
  });
  test('Phase 2: active boss','Above HP threshold boss activates without HP power-up',()=>{
    fixture({summons:false,post:true,hp:25001});ensureSSAnalyticalStance();equal(ssObserverActive(),false,'No observer');equal(actionsForEnemy(ss()),4,'Four actions');assert(ss()._analytical.active,'Analytical is active');equal(maybeRunSSPhase2Cutscene(),false,'25001 does not trigger HP phase');equal(count('hpPhase'),0,'No HP dialogue');equal(ss()._phase2||false,false,'No permanent power-up above threshold');equal(SS_FOCUS_CHANCE_LAST_ACTION,.25,'Normal focus probability');
  });
  for(const hp of [25001,25000,24999])test('Phase 3: HP power-up','Exact threshold at '+hp,async()=>{
    fixture({summons:false,post:true,hp});const p=maybeRunSSPhase2Cutscene();if(hp>25000){equal(p,false,'No power-up above 25000');return;}
    equal(count('hpPhase'),1,'Threshold opens power-up dialogue');locked();equal(ss()._phase2||false,false,'Power-up waits until dialogue ends');
    const again=maybeRunSSPhase2Cutscene();equal(again,p,'Repeated trigger shares in-flight promise');await resolveWithInput(p,'Power-up resolves');textContains(SS_PHASE2_LINES);
    assert(ss()._phase2&&ss()._phase2PermBuff,'Permanent phase markers set');equal(SS_FOCUS_CHANCE_LAST_ACTION,.55,'Focus chance rises only after dialogue');assert(audio.some(e=>e.key==='phase3'),'Power-up selects phase3 music');
    maybeRunSSPhase2Cutscene();equal(count('hpPhase'),1,'Completed power-up does not replay');
  });
  test('Phase 3: HP power-up','Dead boss must not start a power-up dialogue',()=>{
    fixture({summons:false,post:true});ss().hp=0;ss().alive=false;equal(maybeRunSSPhase2Cutscene(),false,'Dead boss rejected');equal(count('hpPhase'),0,'No power-up on dead boss');
  });
  test('Phase 3: HP power-up','HP threshold does not bypass living summons',()=>{
    fixture({hp:25000});maybeRunSSPhase2Cutscene();equal(count('hpPhase'),0,'Observer stage must finish before HP phase dialogue');
  });
  test('Phase 3: HP power-up','Enemy-phase gate does not mark HP transition done above threshold',async()=>{
    fixture({summons:false,post:true,hp:35000});await ensurePhase2DialogueBeforeEnemyPhase();equal(window._ssPhase2Done,false,'HP cutover cannot complete before its threshold');equal(window._forcePlayerTurnAfterPostSummons||false,false,'No spurious player handoff');
  });
  test('Phase 3: HP power-up','Enemy-phase gate waits for dialogue before marking transition done',async()=>{
    fixture({summons:false,post:true,hp:25000});const p=ensurePhase2DialogueBeforeEnemyPhase();equal(count('hpPhase'),1,'Gate starts HP dialogue');equal(window._ssPhase2Done,false,'Gate incomplete while locked');await resolveWithInput(p,'HP gate awaits dialogue');assert(window._ssPhase2Done,'Gate completed after dialogue');
    const atk=atkOf(ss());await ensurePhase2DialogueBeforeEnemyPhase();equal(count('hpPhase'),1,'Gate runs once');equal(atkOf(ss()),atk,'No repeated stat compounding');
  });
  test('Phase 3: HP power-up','Starting another battle resets the increased Focus chance',async()=>{
    fixture({summons:false,post:true,hp:25000});await hpPhase();equal(SS_FOCUS_CHANCE_LAST_ACTION,.55,'Power-up completed');
    resetBattleProgress();equal(SS_FOCUS_CHANCE_LAST_ACTION,.25,'New battle uses normal Focus chance');equal(_ssPhase2Triggered,false,'Power-up trigger resets');equal(window._ssPhase2Done,false,'Completion marker resets');
  });
  test('Phase 3: HP power-up','Effective ATK gains permanent 50% and ignores ATK down',async()=>{
    fixture({summons:false,post:true,hp:25000});const before=atkOf(ss());await hpPhase();equal(atkOf(ss()),Math.round(before*1.5),'Effective ATK uses phase-3 combat multiplier');ss().status.atkDown=4;equal(atkOf(ss()),Math.round(before*1.5),'ATK down ignored');ss().status.atkUp=3;equal(atkOf(ss()),Math.round(before*1.5*1.5),'ATK up still stacks');
  });
  test('Phase 3: HP power-up','Announced permanent DEF increase affects damage calculations',async()=>{
    fixture({summons:false,post:true,hp:25000});const before=defOf(ss());await hpPhase();equal(defOf(ss()),Math.round(before*(window.SS_PHASE2_ATK_DEF_MULT??2)),'Configured permanent DEF increase reaches canonical defense');
  });
  for(const key of ['atkDown','defDown'])test('Phase 3: HP power-up','Boss ignores '+key+' while other enemies remain vulnerable',async()=>{
    fixture({summons:false,post:true,hp:25000});await hpPhase();const effective=key==='atkDown'?atkOf:defOf;const before=effective(ss());addTurns(ss(),key,4);equal(effective(ss()),before,'Phase-specific stat debuff has no combat effect on boss');const other=makeEnemy('Training Target',10000,100,100,0,1000,'low');enemies.push(other);const normal=effective(other);addTurns(other,key,4);equal(other.status[key],4,'Other enemies accept the debuff');equal(effective(other),Math.round(normal*.7),'Other enemies remain vulnerable to the stat reduction');
  });
  test('Phase 3: HP power-up','Other ailments remain usable when Analytical immunity is absent',async()=>{
    fixture({summons:false,post:true,hp:25000});await hpPhase();ss()._analytical.current='REPEL_BASIC';roll=0;addTurns(ss(),'despair',3);equal(ss().status.despair,3,'Despair still applies');
  });
  test('Phase 3: HP power-up','Minimum boss critical chance rises to 40%',async()=>{
    fixture({summons:false,post:true,hp:25000});roll=.39;equal(critRoll(ss(),.1),false,'No 40% floor before power-up');await hpPhase();roll=.39;equal(critRoll(ss(),.1),true,'39% roll crits after power-up');roll=.40;equal(critRoll(ss(),.1),false,'40% boundary does not crit');
  });
  test('Active boss: Analytical','Stance rotates only after every second complete enemy phase',async()=>{
    fixture({summons:false,post:true,hp:35000});window._ssPhase2Done=true;ss()._analytical={active:true,current:'REPEL_BASIC',phaseCounter:0};
    for(let n=1;n<=2;n++){phase='enemy';_inPlayerPhase=false;ss().stunTurns=4;enemyPhaseCounter++;await enemyPhase();equal(ss()._analytical.phaseCounter,n,'Exactly one stance tick per complete enemy phase');if(n===1)equal(ss()._analytical.current,'REPEL_BASIC','First phase retains stance');}
    assert(ss()._analytical.current!=='REPEL_BASIC','Second phase chooses a different relevant stance');equal(phase,'player','Enemy phase returns control');
  });
  test('Player/enemy cycle','Every living ally guards once, then enemies act, then a fresh player phase',async()=>{
    fixture();currentActorIdx=2;party.forEach(p=>p._turnStarted=false);const acted=[];
    for(let n=0;n<4;n++){renderCommandMenu();acted.push(nameOf(party[currentActorIdx]));const guard=buttons().find(b=>b.textContent==='Guard');assert(guard&&!guard.disabled,'Guard available at ready player turn');events.push({name:'guardClick',kind:'input',actor:nameOf(party[currentActorIdx]),connected:guard.isConnected,inFlight:_actionInFlight,handler:String(guard.onclick)});guard.click();await pause(15);const confirm=[...UI.subMenu.querySelectorAll('button')].find(b=>b.textContent.trim()==='Confirm Guard');assert(confirm&&!confirm.disabled,'Guard confirmation is available');confirm.click();await pause(15);if(n<3)equal(phase,'player','No early enemy phase');}
    equal(new Set(acted).size,4,'Each living ally acts exactly once');equal(phase,'enemy','Last ally hands off to enemy');equal(enemyPhaseCounter,2,'One enemy-phase counter increment');
    await drive(()=>phase==='player','Real enemy phase returns control',7000);equal(ss()._phase2||false,false,'No HP power-up during summon phase');equal(nameOf(party[currentActorIdx]),nameOf(party[0]),'Next ordinary phase uses configured first living ally');assert(_actedThisPhase.every(v=>!v),'Turn-use flags reset');
  });
  test('Player/enemy cycle','Dead allies are skipped without consuming an extra turn',()=>{
    fixture();party[3].alive=false;party[3].hp=0;currentActorIdx=2;_actedThisPhase[2]=true;advanceTurn();equal(currentActorIdx,0,'Dead next ally skipped while wrapping');equal(phase,'player','Other living ally still gets a turn');
  });
  test('Player/enemy cycle','Enemy-phase effects reset shields, taunt, and ally turn readiness',async()=>{
    fixture();phase='enemy';_inPlayerPhase=false;enemies.filter(e=>e._summonedBySS).forEach(e=>e.stunTurns=2);party.forEach(p=>{p.status.endureEP=1;p._turnStarted=true;});taunt.turns=2;exclusiveThisPlayerPhase.tauntUsed=true;await enemyPhase();
    equal(phase,'player','Enemy phase finishes');equal(taunt.turns,1,'Taunt expires once per enemy phase');assert(party.every(p=>p.status.endureEP===0),'Breakable Shields expire after one enemy phase');equal(exclusiveThisPlayerPhase.tauntUsed,false,'Taunt exclusivity resets');assert(party.slice(1).every(p=>!p._turnStarted),'Other ally turns remain unstarted');
  });
  test('Dialogue locks/order','Turn effects pause through nested dialogue and resume after the full chain',async()=>{
    fixture();const unit=party[0];unit.status.atkUp=4;unit._turnStarted=false;const before=JSON.stringify(unit.status);
    beginBattleDialogueLock();beginBattleDialogueLock();locked();equal(tickAllyTurnStart(unit),'dialogue','Turn tick rejected during dialogue');equal(JSON.stringify(unit.status),before,'No status tick during dialogue');
    endBattleDialogueLock();await pause(5);assert(isBattleDialogueActive(),'Inner completion keeps outer lock');equal(nameOf(party[currentActorIdx]),'Niko Himura','No intermediate actor shift');endBattleDialogueLock();await pause(20);equal(_battleDialogueLockDepth,0,'All locks released');equal(nameOf(party[currentActorIdx]),'Niko Himura','Full chain resumes at Niko');
    assert(events.filter(e=>e.name==='turnStart'&&e.dialogue).every(e=>e.before===e.after),'No turn-start status changes while any dialogue is active');
  });
  test('Dialogue locks/order','Back-to-back dialogue cannot tick statuses in the gap',async()=>{
    fixture();currentActorIdx=1;_actedThisPhase=party.map(()=>true);party.forEach(p=>p._turnStarted=true);const niko=party[2];niko.status.atkUp=4;const before=niko.status.atkUp;
    beginBattleDialogueLock();endBattleDialogueLock();beginBattleDialogueLock();await pause(15);equal(niko.status.atkUp,before,'Queued reset invalidated by next dialogue');equal(currentActorIdx,1,'Actor unchanged during second dialogue');endBattleDialogueLock();await pause(20);equal(currentActorIdx,2,'Final completion starts Niko');assert(_actedThisPhase.every(v=>!v),'All action usage cleared');equal(niko.status.atkUp,before-1,'One fresh Niko turn ticks status once');
    const starts=events.filter(e=>e.name==='turnStart'&&e.actor==='Niko Himura'&&!e.dialogue&&e.result!=='already');equal(starts.length,1,'Niko prepared once after chain');const banner=events.findIndex(e=>e.name==='turnBanner'&&e.actor==='Niko Himura');const tick=events.findIndex(e=>e.name==='turnStart'&&e.actor==='Niko Himura'&&e.result!=='already');assert(banner>=0&&banner<tick,'Turn banner precedes turn-start effects');
  });
  test('Dialogue locks/order','Attack click cannot act or select a target during dialogue',()=>{
    fixture();const attack=buttons().find(b=>b.textContent==='Attack');const hp=ss().hp;beginBattleDialogueLock();attack.click();equal(selectedAction,null,'Locked click leaves command empty');equal(ss().hp,hp,'Locked click deals no damage');equal(_actedThisPhase.filter(Boolean).length,0,'Locked click consumes no turn');endBattleDialogueLock({resetTurn:false});
  });
  test('Dialogue locks/order','A completed dialogue never restarts an ending battle',async()=>{
    fixture();beginBattleDialogueLock();phase='ending';endBattleDialogueLock();await pause(20);equal(phase,'ending','Ending phase preserved');
  });
  test('Escape ending','Living boss does not trigger ending',async()=>{
    fixture({summons:false,post:true});await ensureSSZeroHPDialogueBeforeEnemyPhase();equal(count('escape'),0,'No ending dialogue while alive');equal(saved.filter(e=>e.method==='finish').length,0,'No early completion history');
  });
  test('Escape ending','Boss defeat plays full ending dialogue once and never revives',async()=>{
    fixture({summons:false,post:true,hp:0});ss().alive=false;await ensureSSZeroHPDialogueBeforeEnemyPhase();equal(count('escape'),1,'Defeat starts escape dialogue');assert(isBattleDialogueActive(),'Ending dialogue locks battle');assert(!document.getElementById('simulationEscapeEndingV89'),'Blackout waits for dialogue');
    await ensureSSZeroHPDialogueBeforeEnemyPhase();equal(count('escape'),1,'Repeated defeat gate does not replay');await drive(()=>phase==='ending','Ending dialogue reaches blackout');textContains(SS_ZEROHP_LINES);equal(ss().hp,0,'Boss stays at zero HP');equal(ss().alive,false,'Boss remains defeated');
    assert(document.querySelector('#simulationEscapeEndingV96, #simulationEscapeEndingV89')?.textContent.includes('You successfully escaped the simulation!'),'Actual escape screen created');assert(saved.some(e=>e.method==='finish'&&e.args[0]==='escaped'),'Escape completion requested');equal(document.querySelectorAll('#simulationEscapeEndingV96, #simulationEscapeEndingV89').length,1,'Only one escape screen exists');
  });
  test('Removed revival/quota phases','Sixteen additional enemies cannot trigger a finale or revive boss',async()=>{
    fixture({summons:false,post:true});for(let n=0;n<16;n++)enemies.push(makeEnemy('Test Subject '+n,1600,100,10,0,500,'low'));const hp=ss().hp;await ensureFinalSixteenDialogueBeforeEnemyPhase();reviveSSAndReset();endBattleBySummonQuota();equal(ss().hp,hp,'Removed revival does not heal boss');equal(phase,'player','Sixteen foes do not end battle');equal(count('escape'),0,'Quota does not trigger escape');equal(saved.filter(e=>e.method==='finish').length,0,'No quota completion recorded');let done=0;runFinalSixteenDialogue(()=>done++);equal(done,1,'Removed dialogue continuation does not hang');assert(!isBattleDialogueActive(),'No removed dialogue lock');
  });
  test('Defeat ending','Niko defeat stops combat and reaches the real game-over screen',async()=>{
    fixture();playNikoGameOverBgmV57=()=>audio.push({key:'gameover'});const niko=party.find(p=>p.name==='Niko Himura');niko.hp=0;niko.alive=false;
    equal(checkEndConditions(),'defeat','Niko defeat detected while other allies live');endGame('defeat');equal(phase,'end','Combat ends immediately');assert(window.__nikoGameOverShiftDisabledV57,'Returning to selection is blocked during defeat');
    await drive(()=>!!document.getElementById('nikoGameOverScreenV57'),'Defeat dialogue reaches game-over screen',10000);
    equal(phase,'end','Game over never re-enters combat');assert(saved.some(e=>e.method==='finish'&&e.args[0]==='defeat'),'Defeat completion requested');assert(audio.some(e=>e.key==='gameover'),'Defeat music route requested');
  });
  for(const stage of ['observer','active','power-up'])test('Save/restore phase state',stage+' resumes without replaying completed transitions',async()=>{
    fixture({summons:stage==='observer',post:stage!=='observer',hp:stage==='power-up'?25000:35000});
    if(stage==='power-up'){await hpPhase();window._ssPhase2Done=true;}
    const adapter=window.__phaseSaveAdapter;assert(adapter,'Real save adapter captured');
    const clone=v=>JSON.parse(JSON.stringify(v));const state={...clone(adapter.snapshot()),schemaVersion:2,battleId:'phase-regression',sequence:0,turn:1};const inventory=clone(adapter.inventory());
    const before={observer:ssObserverActive(),unlocked:ssAnalyticalUnlocked(),power:!!ss()._phase2,atk:atkOf(ss()),def:defOf(ss()),focus:SS_FOCUS_CHANCE_LAST_ACTION};const starts=events.filter(e=>e.kind==='start').length;
    resetBattleProgress();SS_FOCUS_CHANCE_LAST_ACTION=.25; // Fresh-page defaults before restoring the snapshot.
    adapter.restore({state,inventory});await pause(20);
    equal(ssObserverActive(),before.observer,'Observer eligibility preserved');equal(ssAnalyticalUnlocked(),before.unlocked,'Analytical unlock preserved');equal(!!ss()._phase2,before.power,'HP power-up flag preserved');equal(atkOf(ss()),before.atk,'Phase attack preserved');equal(defOf(ss()),before.def,'Phase defense preserved');equal(SS_FOCUS_CHANCE_LAST_ACTION,before.focus,'Focus chance preserved');equal(events.filter(e=>e.kind==='start').length,starts,'No completed dialogue replayed on restore');
  });
  window.__phaseSaveEvent=(method,args)=>saved.push({method,args,phase,locked:isBattleDialogueActive()});
  window.__phaseTests={catalog:cases.map(({group,name})=>({group,name})),async runCase(index){const c=cases[index];let before;try{await acceptWarning();before=snapshot();await c.fn();return {group:c.group,name:c.name,passed:true,assertions,events,audio,saved,after:snapshot()};}catch(error){return {group:c.group,name:c.name,passed:false,error:String(error)+'\n'+(error.stack||''),assertions,events,audio,saved,before,after:snapshot(),transcript:UI.log.textContent,overlay:UI.overlay.textContent};}}};
}

const root=resolve(fileURLToPath(new URL('..',import.meta.url))),reportDir=resolve(process.env.RPG_PHASE_REPORT_DIR||resolve(root,'test-results/phases'));
const originalHtml=await readFile(resolve(root,'index.html'),'utf8'),anchor='\n})();\n\n// === global error fallbacks ===';
if(!originalHtml.includes(anchor))throw Error('Cannot find game closure. No phase tests ran.');
const html=originalHtml.replace(anchor,`\nwindow.addEventListener('DOMContentLoaded',()=>(${installPhaseTests.toString()})(),{once:true});\n${anchor}`);
let server,session;const browserErrors=[];
try{
  server=createServer(async(req,res)=>{
    try{
      const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
      if(name==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}
      if(name==='/save-system.js'){res.setHeader('Content-Type','text/javascript');return res.end('window.RpgSaves=new Proxy({}, {get:(_,key)=>key==="install"?(adapter=>window.__phaseSaveAdapter=adapter):(...args)=>{window.__phaseSaveEvent?.(key,args);return key==="begin"?true:key==="openPicker"?"new":undefined;}});');}
      if(name.startsWith('/api/')){res.writeHead(403);return res.end('Save APIs are disabled in attack tests');}
      const path=resolve(root,'.'+name);if(!path.startsWith(root+sep))throw Error('Bad path');
      res.setHeader('Content-Type',({'.js':'text/javascript','.css':'text/css','.png':'image/png','.jfif':'image/jpeg','.mp3':'audio/mpeg','.webm':'video/webm'})[extname(path)]||'application/octet-stream');res.end(await readFile(path));
    }catch{res.writeHead(404);res.end();}
  });
  await new Promise((done,failed)=>{server.once('error',failed);server.listen(0,'127.0.0.1',done);});
  session=await launchTestBrowser({onEvent(method,p){if(method==='Runtime.exceptionThrown')browserErrors.push(p.exceptionDetails);}});
  await session.page.call('Runtime.enable');await session.page.call('Page.enable');
  await session.page.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
  let loaded=false;
  for(let i=0;i<100;i++){const result=await session.page.call('Runtime.evaluate',{expression:'!!window.__phaseTests',returnByValue:true});if(result.result?.value){loaded=true;break;}await new Promise(done=>setTimeout(done,100));}
  if(!loaded)throw Error('Phase test adapter failed to initialize: '+JSON.stringify(browserErrors));
  async function evaluate(expression){const r=await session.page.call('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
  const catalog=await evaluate('window.__phaseTests.catalog');
  const report={results:[],scope:'Real phase gates, dialogue handlers, UI locks, turn advancement and phase-specific effects; fresh page per case. Audio output and enemy pacing are isolated. No save APIs are enabled.',contracts:['Opening completes prefight and summon dialogue before the first ready turn.','Each summon defeat applies only its own effect; both defeats precede the post-summons transition.','Boss observer, active and HP-power-up stages have separate eligibility and effects.','Dialogue chains pause turn effects and restart at Niko only after the complete chain.','Boss defeat plays the escape ending; removed revival and quota phases stay disabled.']};
  for(let i=0;i<catalog.length;i++){
    if(i){
      await session.page.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/?case=${i}`});
      let ready=false;for(let attempt=0;attempt<100;attempt++){if(await evaluate('!!window.__phaseTests')){ready=true;break;}await new Promise(r=>setTimeout(r,50));}if(!ready)throw Error('Phase adapter did not load for '+catalog[i].name);
    }
    const row=await evaluate(`window.__phaseTests.runCase(${i})`);report.results.push(row);
    console.log(`${row.passed?'PASS':'FAIL'} ${row.group} / ${row.name}${row.error?': '+row.error.split('\n')[0]:''}`);
  }
  for(const error of browserErrors)report.results.push({group:'Browser',name:'Uncaught exception',passed:false,error:JSON.stringify(error)});
  report.generatedAt=new Date().toISOString();report.browser=session.selected.name;report.passed=report.results.filter(r=>r.passed).length;report.failed=report.results.length-report.passed;
  await mkdir(reportDir,{recursive:true});await writeFile(resolve(reportDir,'phases.json'),JSON.stringify(report,null,2)+'\n');
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const groups=[...new Set(report.results.map(r=>r.group))];
  const page=`<!doctype html><html lang="en"><meta charset="utf-8"><title>Phase and dialogue tests</title><style>body{font:16px/1.5 system-ui;max-width:1200px;margin:30px auto;padding:0 20px;background:#101426;color:#e7e9f7}.pass{color:#7be5a0}.fail{color:#ff9898}details{border:1px solid #39407a;border-radius:8px;padding:12px;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}summary{cursor:pointer}table{border-collapse:collapse}td,th{padding:6px 12px;text-align:left;border:1px solid #39407a}</style><h1>Phases, dialogue, and turn transitions</h1><p class="pass">${report.passed} passed</p><p class="fail">${report.failed} failed</p><p>${escape(report.browser)} · ${escape(report.generatedAt)}</p><p>${escape(report.scope)}</p><details><summary>Phase and dialogue contracts</summary><ul>${report.contracts.map(c=>`<li>${escape(c)}</li>`).join('')}</ul></details>${groups.map(group=>{const rows=report.results.filter(r=>r.group===group);return `<h2>${escape(group)} · ${rows.filter(r=>r.passed).length}/${rows.length}</h2>${rows.map(r=>`<details ${r.passed?'':'open'}><summary class="${r.passed?'pass':'fail'}">${r.passed?'PASS':'FAIL'} · ${escape(r.name)}</summary>${r.error?`<pre>${escape(r.error)}</pre>`:''}<table><tr><th>Check</th><th>Expected</th><th>Actual</th></tr>${(r.assertions||[]).map(a=>`<tr><td>${escape(a.label)}</td><td>${escape(a.expected)}</td><td>${escape(a.actual)}</td></tr>`).join('')}</table><details><summary>Phase, dialogue, audio and turn evidence</summary><pre>${escape(JSON.stringify({events:r.events,audio:r.audio,saved:r.saved,after:r.after},null,2))}</pre></details>${r.transcript?`<details><summary>Battle transcript</summary><pre>${escape(r.transcript)}</pre></details>`:''}</details>`).join('')}`;}).join('')}</html>`;
  await writeFile(resolve(reportDir,'phases-report.html'),page);
  for(const group of groups){const rows=report.results.filter(r=>r.group===group);console.log(`${group}: ${rows.filter(r=>r.passed).length}/${rows.length} passed`);}
  for(const test of report.results.filter(r=>!r.passed))console.error(`FAIL ${test.group} / ${test.name}: ${test.error.split('\n')[0]}`);
  console.log(`\nPhase tests: ${report.passed} passed, ${report.failed} failed.\nReport: ${resolve(reportDir,'phases-report.html')}`);process.exitCode=report.failed?1:0;
}catch(error){console.error(error.stack||error);process.exitCode=1;}
finally{if(session)await session.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}}

}

// ========================================================================
// testSaveFlow: merged from scripts/verify-save-flow.mjs
// ========================================================================
async function testSaveFlow() {
const { default: assert } = await import("node:assert/strict");
const { launchTestBrowser } = await import("./browser-automation.mjs");
const baseUrl = process.env.RPG_TEST_URL || 'http://localhost:3011';
const errors=[];
const session=await launchTestBrowser({onEvent(method,p){if(method==='Runtime.exceptionThrown')errors.push(p.exceptionDetails);}});
const send=async(method,params={})=>({result:await session.page.call(method,params)});
const ev=async expression=>{const m=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(m.result?.exceptionDetails)throw Error(JSON.stringify(m.result.exceptionDetails));return m.result.result.value;};
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const poll=async(expression,timeout=10000)=>{for(let i=0;i<timeout/100;i++){if(await ev(expression))return;await wait(100);}throw Error('Timeout: '+expression);};
const get=path=>ev(`fetch(${JSON.stringify(path)}).then(r=>r.json())`);
try {
await send('Runtime.enable');await send('Page.enable');await send('Page.navigate',{url:baseUrl});await wait(1200);
await ev("document.getElementById('introYesBtnV56').click()");
await poll("document.querySelector('.rpg-save-dialog')?.open");
await poll("document.querySelectorAll('.rpg-save-slot').length===6");
assert.equal(await ev("getComputedStyle(document.getElementById('selectPanel')).visibility"),'hidden');
assert.equal(await ev("[...document.querySelectorAll('.rpg-save-slot')].every(b=>b.disabled)"),true);
console.log('Opening picker hides party selection and shows six empty slots');
await ev("[...document.querySelectorAll('.rpg-save-dialog button')].find(b=>b.textContent==='New Battle').click()");
await ev("[...document.querySelectorAll('#candidateGrid > .card')].slice(0,3).forEach(x=>x.click());document.getElementById('startBtn').click()");
assert.deepEqual(await get('/api/saves'),[]);
console.log('No autosave during introductory cutscenes');
await ev(`new Promise(resolve=>{let n=0;const timer=setInterval(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',code:'ControlLeft',bubbles:true}));if(++n===400 || (!document.querySelector('#rpg-save-controls [data-save]').disabled && getComputedStyle(document.getElementById('dialogueOverlay')).display==='none')){clearInterval(timer);resolve('intro finished');}},70);})`);
await poll("fetch('/api/saves').then(r=>r.json()).then(s=>s.some(x=>x.slot===6))");
const auto = await get('/api/saves/6');
console.log('Autosave created',JSON.stringify({actor:auto.state.flags.currentActorIdx,party:auto.state.party.map(x=>x.name)}));
await poll("!document.querySelector('#rpg-save-controls [data-save]').disabled");
await ev("document.querySelector('#rpg-save-controls [data-save]').click()");
await poll("document.querySelector('.rpg-save-slot[data-slot=\"6\"]')?.disabled");
await ev("document.querySelector('.rpg-save-slot[data-slot=\"1\"]').click()");
await poll("!document.querySelector('.rpg-save-dialog')");
assert.ok(await get('/api/saves/1'));
console.log('Manual slot 1 saved; slot 6 disabled in manual picker');
await ev("window.__testRandom=Math.random;Math.random=()=>0.99;[...document.querySelectorAll('#menu button')].find(b=>b.textContent.trim()==='Guard').click()");
assert.equal(await ev("document.querySelector('#rpg-save-controls [data-save]').disabled"),true);
await ev("[...document.querySelectorAll('#subMenu button')].find(b=>/Confirm Guard/.test(b.textContent)).click()");
await poll("!document.querySelector('#rpg-save-controls [data-save]').disabled");
await poll("fetch('/api/history').then(r=>r.json()).then(h=>h[0]?.decisions.length===1)");
assert.deepEqual((await get('/api/saves/6')).state, auto.state);
await ev("document.querySelector('#rpg-save-controls [data-save]').click()");await poll("document.querySelector('.rpg-save-slot[data-slot=\"1\"]')");
await ev("document.querySelector('.rpg-save-slot[data-slot=\"1\"]').click()");
assert.match(await ev("document.querySelector('.rpg-save-dialog [role=status]').textContent"),/Overwrite/);
await ev("[...document.querySelectorAll('.rpg-save-dialog button')].find(b=>b.textContent==='Overwrite').click()");
await poll("!document.querySelector('.rpg-save-dialog')");
const manual = await get('/api/saves/1');assert.equal(manual.state.flags.currentActorIdx,1);
console.log('Guard recorded; autosave unchanged; manual overwrite captured next actor');
await ev("Math.random=window.__testRandom;delete window.__testRandom");
await send('Page.reload');await wait(1200);await ev("document.getElementById('introYesBtnV56').click()");
await poll("document.querySelector('.rpg-save-slot[data-slot=\"1\"]') && !document.querySelector('.rpg-save-slot[data-slot=\"1\"]').disabled");
await ev("document.querySelector('.rpg-save-slot[data-slot=\"1\"]').click()");
await poll("!document.querySelector('.rpg-save-dialog')");
console.log('After load:',await ev("({status:document.querySelector('#rpg-save-controls [role=status]').textContent,battle:getComputedStyle(document.getElementById('battleUI')).display,menu:document.getElementById('menu').textContent,saveDisabled:document.querySelector('#rpg-save-controls [data-save]').disabled})"));
await poll("!document.querySelector('#rpg-save-controls [data-save]').disabled");
await ev("document.querySelector('#rpg-save-controls [data-save]').click()");await poll("document.querySelector('.rpg-save-slot[data-slot=\"2\"]')");
await ev("document.querySelector('.rpg-save-slot[data-slot=\"2\"]').click()");await poll("!document.querySelector('.rpg-save-dialog')");
const resumed = await get('/api/saves/2');
assert.deepEqual(resumed.state.party,manual.state.party);assert.deepEqual(resumed.state.enemies,manual.state.enemies);assert.deepEqual(resumed.inventory,manual.inventory);assert.deepEqual(resumed.state.flags,manual.state.flags);
assert.deepEqual((await get('/api/saves/6')).state,auto.state);
console.log('Loaded battle matches saved party, enemies, inventory and all turn flags; autosave unchanged');
await ev("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',code:'ShiftLeft',bubbles:true}))");await wait(500);
assert.equal(await ev("!!document.querySelector('.rpg-save-dialog')"),false);
assert.equal(await ev("getComputedStyle(document.getElementById('battleUI')).display"),'none');
assert.equal(await ev("document.querySelector('#rpg-save-controls [data-load]')"),null);
console.log('Returning to party selection does not reopen loading');
const oldOpening=await get('/api/saves/6'), manualBeforeNewBattle=await get('/api/saves/1');
await ev("document.getElementById('startBtn').click()");
assert.equal(await ev("!!document.querySelector('.rpg-save-dialog')"),false);
await ev(`new Promise(resolve=>{let n=0;const timer=setInterval(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',code:'ControlLeft',bubbles:true}));if(++n===400 || (!document.querySelector('#rpg-save-controls [data-save]').disabled && getComputedStyle(document.getElementById('dialogueOverlay')).display==='none')){clearInterval(timer);resolve();}},70);})`);
await poll(`fetch('/api/saves/6').then(r=>r.json()).then(x=>x.state.battleId!==${JSON.stringify(oldOpening.state.battleId)})`);
assert.deepEqual((await get('/api/saves/1')).state,manualBeforeNewBattle.state);
console.log('A second battle replaces only slot 6 after the opening sequence');
await ev("window.__testRandom = Math.random; Math.random=()=>0.99");
for(let i=0;i<4;i++){
 console.log("Guarding actor",i);
 await poll("!document.querySelector('#rpg-save-controls [data-save]').disabled");
 await ev("[...document.querySelectorAll('#menu button')].find(b=>b.textContent.trim()==='Guard').click()");
 await wait(120);
 await ev("[...document.querySelectorAll('#subMenu button')].find(b=>/Confirm Guard/.test(b.textContent) && !b.disabled).click()");
}
await wait(100);
assert.equal(await ev("document.querySelector('#rpg-save-controls [data-save]').disabled"),true);
console.log('Manual save disabled while the enemy phase runs');
await poll("!document.querySelector('#rpg-save-controls [data-save]').disabled",45000);
await ev("Math.random=window.__testRandom; delete window.__testRandom");
const history=await get('/api/history');
console.log('After enemy phase:',history[0].decisions.map(d=>({actor:d.actor_id,action:d.action_type,ability:d.ability_or_item_id})));
assert.ok(history[0].decisions.some(d=>d.action_type==='enemy-action'));
assert.equal((await get('/api/saves/6')).state.sequence,0);
console.log('Manual save reenabled at the next player turn; enemy decisions recorded');
await send('Page.reload');await wait(1000);await ev("document.getElementById('introYesBtnV56').click()");await poll("document.querySelector('.rpg-save-slot[data-slot=\"6\"]') && !document.querySelector('.rpg-save-slot[data-slot=\"6\"]').disabled");
const screenshot=await send('Page.captureScreenshot',{format:'png'});
const fs=await import('node:fs');fs.writeFileSync(process.env.RPG_SCREENSHOT || '/tmp/rpg-save-picker.png',Buffer.from(screenshot.result.data,'base64'));

assert.deepEqual(errors,[]);console.log('PASS');
await session.close();

} catch (error) {
  console.error(error);process.exitCode=1;
  try { console.error('DOM STATE',await ev("({status:document.querySelector('#rpg-save-controls [role=status]')?.textContent,menu:document.getElementById('menu')?.textContent,sub:document.getElementById('subMenu')?.textContent})")); } catch {}
  await session.close();
}

}

// ========================================================================
// testInitialization: merged from scripts/verify-initialization.mjs
// ========================================================================
async function testInitialization() {
/**
 * Startup, media and image regression tests: npm run test:init
 * Uses the REAL server (temporary PostgreSQL directory) plus in-memory diagnostic bindings.
 * No media stubs, forced autoplay policy, or production file rewrites.
 * The system default browser is launched with a fresh profile and muted output.
 * Set RPG_TEST_BROWSER or RPG_INIT_REPORT_DIR to override discovery/output.
 */
const { readFile, writeFile, mkdir, mkdtemp, rm, readdir } = await import("node:fs/promises");
const { createServer } = await import("node:net");
const { spawn } = await import("node:child_process");
const { tmpdir } = await import("node:os");
const { resolve, relative, extname, sep } = await import("node:path");
const { fileURLToPath } = await import("node:url");
const { createHash } = await import("node:crypto");
const { launchTestBrowser } = await import("./browser-automation.mjs");
const { createServer: createHttpServer, request: forwardRequest } = await import("node:http");

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const reportDir = resolve(process.env.RPG_INIT_REPORT_DIR || resolve(root, 'test-results/initialization'));
const temporary = await mkdtemp(resolve(tmpdir(), 'rpg-initialization-'));
const checks = [], browserErrors = [], requests = [], loadingFailures = [], plays = [];
let serverProcess, browserProcess, browser, page, proxyServer, stage = 'startup', baseUrl;
const wait = ms => new Promise(done => setTimeout(done, ms));
const assert = (value, message) => { if (!value) throw Error(message); };
const short = value => value.startsWith('data:') ? `${value.slice(0, value.indexOf(',') + 1)} [${createHash('sha256').update(value).digest('hex').slice(0, 12)}]` : value;
const errorText = error => error instanceof Error ? error.message : String(error);
async function check(group, name, task, references = []) {
  const start = Date.now();
  try { const evidence = await task(); checks.push({ group, name, passed: true, evidence, references, ms: Date.now() - start }); }
  catch (error) { checks.push({ group, name, passed: false, error: errorText(error), references, ms: Date.now() - start }); console.error(`FAIL ${group} / ${name}: ${errorText(error)}`); }
}
async function evaluate(expression, userGesture = false) {
  const result = await page.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
  if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function coreBindings() {
  await poll('!!window.__rpgInitBindings');
  const descriptors = await evaluate("Object.entries(window.__rpgInitBindings).map(([name,value])=>[name,{primitive:typeof value==='string',value:typeof value==='string'?value:null}])");
  return new Map(descriptors.map(([name,meta])=>[name,meta.primitive?{value:meta.value}:{expression:'window.__rpgInitBindings['+JSON.stringify(name)+']'}]));
}
async function objectValue(value, transform = 'function(){return this;}') {
  if (!value?.expression) return value?.value;
  return evaluate(`(${transform}).call(${value.expression})`);
}
async function callCore(bindings, name, args = []) {
  const fn=bindings.get(name);assert(fn?.expression,`Game function missing: ${name}`);
  return evaluate(`${fn.expression}(...${JSON.stringify(args)})`,true);
}
async function poll(expression, timeout = 12000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await evaluate(expression)) return; await wait(100); }
  throw Error(`Timed out waiting for: ${expression}`);
}
async function click(selector) {
  const bounds = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'center'});const b=e.getBoundingClientRect();return {x:b.x+b.width/2,y:b.y+b.height/2};})()`);
  assert(bounds, `Clickable control missing or disabled: ${selector}`);
  await page.call('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...bounds });
  await page.call('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...bounds });
}
async function screenshot(name) {
  const result = await page.call('Page.captureScreenshot', { format: 'png' });
  await writeFile(resolve(reportDir, `${name}.png`), Buffer.from(result.data, 'base64'));
}

async function files(dir = root) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || ['node_modules', 'data', 'test-results', 'dist', '.aws-sam'].includes(entry.name)) continue;
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) found.push(...await files(path));
    else if (entry.isFile()) found.push(relative(root, path).split(sep).join('/'));
  }
  return found;
}
function stringReferences(source) {
  // Read quoted JS strings, ignoring comments and interpolated templates.
  const result = []; let i = 0;
  while (i < source.length) {
    if (source.slice(i, i + 2) === '//') { i = source.indexOf('\n', i + 2); if (i < 0) break; continue; }
    if (source.slice(i, i + 2) === '/*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    const quote = source[i];
    if (!['"', "'", '`'].includes(quote)) { i++; continue; }
    const start = ++i; let body = '';
    while (i < source.length && source[i] !== quote) {
      if (source[i] === '\\' && i + 1 < source.length) { const next = source[++i]; body += ({ n: '\n', r: '\r', t: '\t' })[next] ?? next; i++; }
      else body += source[i++];
    }
    i++;
    const concatenated = source.slice(0, start - 1).trimEnd().endsWith('+') || source.slice(i).trimStart().startsWith('+');
    if (!concatenated && !body.includes('${') && !/[<>\r\n]/.test(body) && /\.(?:png|jpe?g|jfif|webp|gif|svg|mp3|wav|ogg|webm|mp4|mkv)(?:[?#].*)?$/i.test(body)) result.push({ src: body, offset: start });
  }
  return result;
}

function installBrowserProbes() {
  window.__initPlays = [];
  const play = HTMLMediaElement.prototype.play;
  // Observe the ORIGINAL play promise, even when the game silently catches it.
  HTMLMediaElement.prototype.play = function(...args) {
    const event = { src: this.currentSrc || this.src, bgmKey: this.dataset?.bgmKey || null, stage: window.__initStage || 'startup', muted: this.muted, volume: this.volume, status: 'pending' };
    window.__initPlays.push(event);
    try {
      const promise = play.apply(this, args);
      Promise.resolve(promise).then(() => { event.status = 'playing'; }, error => { event.status = 'failed'; event.error = error.name + ': ' + error.message; });
      return promise;
    } catch (error) { event.status = 'failed'; event.error = error.name + ': ' + error.message; throw error; }
  };
  window.__initProbe = async function(src, kind) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 12000);
    let media;
    try {
      const response = await fetch(src, { signal: controller.signal });
      if (!response.ok) throw Error(`HTTP ${response.status}: ${response.url}`);
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) throw Error('Asset is empty');
      const evidence = { bytes: bytes.byteLength, mime: response.headers.get('content-type'), status: response.status };
      if (kind === 'image') {
        const img = new Image(); img.src = src;
        await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(Error('Image decode timed out')), 10000))]);
        if (!(img.naturalWidth > 0 && img.naturalHeight > 0)) throw Error('Decoded image has zero dimensions');
        return { ...evidence, width: img.naturalWidth, height: img.naturalHeight };
      }
      // Byte ranges are tested against the actual game server, not a test file server.
      if (/^https?:/.test(new URL(src, location.href).protocol)) {
        const range = await fetch(src, { headers: { Range: 'bytes=0-63' }, signal: controller.signal });
        if (range.status !== 206 || !range.headers.get('content-range')?.startsWith('bytes 0-')) throw Error('Server did not serve a valid media byte range');
        const ranged = await range.arrayBuffer();
        if (ranged.byteLength !== Math.min(64, bytes.byteLength)) throw Error('Incorrect media range body length');
      }
      if (/\.(?:mp3|wav|ogg)(?:$|[?#])/i.test(src)) {
        const context = window.__initAudioContext ||= new AudioContext();
        await context.resume();
        const audio = await context.decodeAudioData(bytes.slice(0));
        if (!(audio.duration > 0 && audio.numberOfChannels > 0 && audio.length > 0)) throw Error('Audio decoder returned no samples');
        let peak = 0; const samples = audio.getChannelData(0);
        for (let i = 0; i < samples.length; i += Math.max(1, Math.floor(samples.length / 50000))) peak = Math.max(peak, Math.abs(samples[i]));
        if (peak <= 0.000001) throw Error('Decoded audio appears silent');
        Object.assign(evidence, { decodedSeconds: audio.duration, sampleRate: audio.sampleRate, channels: audio.numberOfChannels, peak });
      }
      media = document.createElement(/\.(?:webm|mp4|mkv)(?:$|[?#])/i.test(src) ? 'video' : 'audio');
      media.preload = 'auto'; media.playsInline = true; media.muted = false; media.volume = 0.2;
      Object.assign(media.style, { position: 'fixed', width: '2px', height: '2px', left: '0', bottom: '0' });
      document.documentElement.appendChild(media);
      const loaded = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(Error('Media metadata/data timed out')), 10000);
        media.addEventListener('loadeddata', () => { clearTimeout(timeout); resolve(); }, { once: true });
        media.addEventListener('error', () => { clearTimeout(timeout); reject(Error(`MediaError ${media.error?.code}: ${media.error?.message || 'Cannot decode media'}`)); }, { once: true });
      });
      media.src = src; media.load(); await loaded;
      if (!(Number.isFinite(media.duration) && media.duration > 0)) throw Error('Media has no finite positive duration');
      await media.play();
      await new Promise(resolve => setTimeout(resolve, 300));
      if (media.error) throw Error(`Playback MediaError ${media.error.code}: ${media.error.message}`);
      if (!(media.currentTime > 0.015)) throw Error('Playback clock did not advance');
      if (media.paused && !media.ended) throw Error('Playback unexpectedly paused');
      Object.assign(evidence, { duration: media.duration, playedTo: media.currentTime, readyState: media.readyState, videoWidth: media.videoWidth || 0, videoHeight: media.videoHeight || 0 });
      const capture=media.captureStream||media.mozCaptureStream;
      if (typeof capture === 'function') {
        const stream = capture.call(media); evidence.audioTracks = stream.getAudioTracks().length;
        stream.getTracks().forEach(track => track.stop());
        if (!evidence.audioTracks) throw Error('Music/SFX media contains no audio track');
      }
      // Check that near-end data can be read, not just the first media headers.
      if (media.duration > 1) {
        const target = media.duration * 0.8;
        await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => reject(Error('Media seek/decode timed out')), 6000);
          media.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
          media.addEventListener('error', () => { clearTimeout(timeout); reject(Error('Media failed while seeking')); }, { once: true });
          media.currentTime = target;
        });
        if (Math.abs(media.currentTime - target) > 1) throw Error('Media could not seek to later content');
        evidence.seekedTo = media.currentTime;
      }
      return evidence;
    } finally {
      clearTimeout(timer);
      if (media) { media.pause(); media.removeAttribute('src'); media.load(); media.remove(); }
    }
  };
  window.__initDomAssets = function() {
    const found = [];
    for (const img of document.images) if (img.getAttribute('src')) found.push({ src: img.src, kind: 'image', reference: 'DOM image #' + (img.id || img.className || img.alt || '(unnamed)') });
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        for (const property of ['backgroundImage', 'maskImage', 'borderImageSource']) for (const match of (style[property] || '').matchAll(/url\((?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^)]*))\)/g)) found.push({ src: match[1] ?? match[2] ?? match[3], kind: 'image', reference: `${element.tagName}#${element.id}${pseudo || ''} ${property}` });
      }
    }
    return found;
  };
}

try {
  await mkdir(reportDir, { recursive: true });
  const reserve = createServer(); await new Promise((done, failed) => { reserve.once('error', failed); reserve.listen(0, '127.0.0.1', done); });
  const port = reserve.address().port; await new Promise(done => reserve.close(done));
  baseUrl = `http://127.0.0.1:${port}`;
  let serverOutput = '';
  serverProcess = spawn(process.execPath, [resolve(root, 'server/server.js')], { cwd: root, env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), RPG_LOCAL_DB: resolve(temporary, 'test-postgres'), RPG_DSQL_HOST: '', DATABASE_URL: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  serverProcess.stdout.on('data', chunk => serverOutput += chunk.toString()); serverProcess.stderr.on('data', chunk => serverOutput += chunk.toString());
  let serverReady = false;
  for (let i = 0; i < 100; i++) { try { const r = await fetch(baseUrl + '/api/saves'); if (r.ok) { serverReady = true; break; } } catch {} await wait(100); }
  assert(serverReady, 'Test server failed to start: ' + serverOutput);
  // Add read-only diagnostic references to an in-memory HTML response only.
  // The upstream server still serves every API and media byte-range request.
  const upstream = baseUrl;
  const source = await readFile(resolve(root,'index.html'),'utf8');
  const marker = '\n})();\n\n// === global error fallbacks ===';
  assert(source.includes(marker),'Game closure anchor missing; diagnostic bindings cannot initialize');
  const names='LOCAL_BGM_KEYS _SFX_BANK ROSTER SELECT_PORTRAITS PORTRAITS ALLY_HURT_PORTRAITS ENEMY_HURT_PORTRAITS ALLY_KO_PORTRAITS ENEMY_DEFEAT_PORTRAITS NIKO_GAME_OVER_BGM_FILE_V57 getActorSkills swapBattleBgm goSilentNow playSfxKey playNikoGameOverBgmV57 fadeOutNikoGameOverBgmV57 fadePlayer duckBGM'.split(' ');
  const diagnosticHtml=source.replace(marker,'\nObject.defineProperty(window,"__rpgInitBindings",{value:{'+names.join(',')+'}});'+marker);
  proxyServer=createHttpServer((req,res)=>{
    if(req.url==='/'&&req.method==='GET'){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});return res.end(diagnosticHtml);}
    const forwarded=forwardRequest(upstream+req.url,{method:req.method,headers:req.headers},response=>{res.writeHead(response.statusCode,response.headers);response.pipe(res);});
    forwarded.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end();});req.pipe(forwarded);
  });
  await new Promise((done,failed)=>{proxyServer.once('error',failed);proxyServer.listen(0,'127.0.0.1',done);});
  baseUrl=`http://127.0.0.1:${proxyServer.address().port}`;
  const session=await launchTestBrowser({profile:resolve(temporary,'browser'),muted:true,onEvent(method,p){
    if(method==='Runtime.exceptionThrown')browserErrors.push({stage,...p.exceptionDetails});
    if(method==='Network.responseReceived')requests.push({stage,id:p.requestId,url:p.response.url,status:p.response.status,mime:p.response.mimeType});
    if(method==='Network.loadingFailed')loadingFailures.push({stage,id:p.requestId,error:p.errorText,canceled:p.canceled});
  }});
  browser=session.browser;page=session.page;browserProcess=session.process;
  await page.call('Runtime.enable'); await page.call('Page.enable'); await page.call('Network.enable');
  await page.call('Emulation.setDeviceMetricsOverride', { width: 1600, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.call('Page.addScriptToEvaluateOnNewDocument', { source: `(${installBrowserProbes.toString()})();` });
  await page.call('Page.navigate', { url: baseUrl });
  await poll("document.readyState==='complete' && !!window.RpgSaves && !!document.getElementById('introYesBtnV56')");
  const bindings = await coreBindings();
  const manifest = new Map();
  function add(src, kind, reference) {
    if (typeof src !== 'string' || !src) return;
    let url; try { url = new URL(src, baseUrl + '/').href; } catch { return; }
    const item = manifest.get(url) || { url, name: short(src), kind, references: [] };
    if (reference && !item.references.includes(reference)) item.references.push(reference);
    manifest.set(url, item);
  }
  async function gatherDom(label) { for (const item of await evaluate('window.__initDomAssets()')) add(item.src, item.kind, label + ': ' + item.reference); }
  const bgm = await objectValue(bindings.get('LOCAL_BGM_KEYS'));
  const sfx = await objectValue(bindings.get('_SFX_BANK'), 'function(){return Object.entries(this).map(([key,audio])=>({key,src:audio.src,preload:audio.preload,error:audio.error?{code:audio.error.code,message:audio.error.message}:null}));}');
  for (const [key, src] of Object.entries(bgm)) add(src, 'audio', 'Registered music: ' + key);
  add(bindings.get('NIKO_GAME_OVER_BGM_FILE_V57')?.value, 'audio', 'Game-over music');
  for (const cue of sfx) add(cue.src, 'audio', 'Registered SFX: ' + cue.key);
  for (const registry of ['SELECT_PORTRAITS', 'PORTRAITS', 'ALLY_HURT_PORTRAITS', 'ENEMY_HURT_PORTRAITS', 'ALLY_KO_PORTRAITS', 'ENEMY_DEFEAT_PORTRAITS']) {
    const map = await objectValue(bindings.get(registry)); for (const [name, src] of Object.entries(map || {})) add(src, 'image', registry + ': ' + name);
  }
  for (const character of Object.keys(await objectValue(bindings.get('ROSTER')))) for (const skill of await callCore(bindings, 'getActorSkills', [{ name: character }])) if (skill.sfxUrl) add(skill.sfxUrl, 'audio', `Declared skill SFX: ${character} / ${skill.name}`);
  const html = await readFile(resolve(root, 'index.html'), 'utf8');
  for (const script of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)) {
    for (const reference of stringReferences(script[1])) {
      const offset = script.index + script[0].indexOf(script[1]) + reference.offset;
      const line = html.slice(0, offset).split('\n').length;
      add(reference.src, /\.(mp3|wav|ogg|webm|mp4|mkv)(?:$|[?#])/i.test(reference.src) ? 'audio' : 'image', `Literal reference: index.html:${line}`);
    }
  }
  const disk = await files();
  for (const path of disk) if (/\.(png|jpe?g|jfif|svg|webp|gif|mp3|wav|ogg|webm|mp4|mkv)$/i.test(path)) add(path, /\.(mp3|wav|ogg|webm|mp4|mkv)$/i.test(path) ? 'audio' : 'image', 'Asset file on disk');
  await check('Initialization', 'Main document and core game initialize without uncaught errors', async () => { assert(!browserErrors.length, JSON.stringify(browserErrors)); return { readyState: await evaluate('document.readyState'), musicCues: Object.keys(bgm).length, sfxCues: sfx.length }; });
  await check('Visuals', 'Opening warning and Yes button are visible and reachable', async () => {
    const result = await evaluate("(()=>{const e=document.getElementById('introYesBtnV56'),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {text:document.getElementById('introCoverV56').innerText,enabled:!e.disabled,width:r.width,height:r.height,visible:s.visibility!=='hidden'&&s.display!=='none',reachable:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.closest('#introYesBtnV56')===e};})()");
    assert(result.visible && result.enabled && result.width > 0 && result.height > 0 && result.reachable, JSON.stringify(result)); return result;
  });
  await check('Music', 'Registered players preload while the warning remains silent', async () => {
    await poll("[...document.querySelectorAll('audio[data-bgm-key],video[data-bgm-key]')].every(m=>!m.error&&m.readyState>=2)");
    const players=await evaluate("[...document.querySelectorAll('audio[data-bgm-key],video[data-bgm-key]')].map(m=>({key:m.dataset.bgmKey,src:m.src,readyState:m.readyState,silent:m.paused||m.muted||m.volume===0}))");
    assert(players.length===new Set(Object.values(bgm)).size,'Not every unique music track has an initialized player');
    assert(players.every(m=>m.silent),'Music played audibly before the warning was accepted');return players;
  });
  await check('Visuals', 'Stylesheets and declared fonts initialize', async () => {
    const result=await evaluate("(async()=>{await document.fonts.ready;const fonts=await Promise.all([...document.fonts].map(async f=>{try{await f.load();return {family:f.family,status:f.status};}catch(e){return {family:f.family,status:'failed',error:e.message};}}));return {stylesheets:document.styleSheets.length,saveStyles:!!document.querySelector('link[href=\"save-system.css\"]')?.sheet,fonts};})()");
    assert(result.stylesheets>0&&result.saveStyles&&result.fonts.every(f=>f.status==='loaded'),JSON.stringify(result));return result;
  });
  await screenshot('01-warning'); await gatherDom('Warning screen');
  await check('Initialization', 'Yes opens the six-slot picker before party selection', async () => { await click('#introYesBtnV56'); await poll("document.querySelectorAll('.rpg-save-slot').length===6"); const result = await evaluate("({slots:document.querySelectorAll('.rpg-save-slot').length,selectionHidden:getComputedStyle(document.getElementById('selectPanel')).visibility==='hidden'})"); assert(result.selectionHidden, 'Party selection was exposed before choosing a save or New Battle'); return result; });
  await screenshot('02-save-picker');
  await check('Initialization', 'New Battle initializes all party selection cards', async () => {
    const selector = await evaluate("(()=>{const b=[...document.querySelectorAll('.rpg-save-dialog button')].find(e=>e.textContent==='New Battle');b.id='init-new-battle';return '#init-new-battle';})()"); await click(selector);
    await poll("getComputedStyle(document.getElementById('selectPanel')).visibility!=='hidden'");
    const count = await evaluate("document.querySelectorAll('#candidateGrid > .card').length"); assert(count === 5, `Expected five optional characters, got ${count}`); return { optionalCharacters: count, lockedLeader: 1 };
  });
  await gatherDom('Party selection'); await screenshot('03-party-selection');
  await check('Music', 'Character selection music starts after user interaction', async () => {
    await poll("(()=>{const m=document.querySelector('#selectBgm audio,#selectBgm video');return m&&!m.paused&&!m.muted&&m.volume>0&&m.currentTime>0.02&&!m.error;})()", 10000);
    return evaluate("(()=>{const m=document.querySelector('#selectBgm audio,#selectBgm video');return {src:m.currentSrc,time:m.currentTime,volume:m.volume};})()");
  });
  await check('Initialization', 'Party selection enables Start Battle after three choices', async () => {
    for (let i = 1; i <= 3; i++) await click(`#candidateGrid > .card:nth-child(${i})`);
    const enabled = await evaluate("!document.getElementById('startBtn').disabled"); assert(enabled, 'Start Battle stayed disabled'); return { selected: 3 };
  });
  await click('#startBtn'); await wait(500); await gatherDom('Prefight'); await screenshot('04-prefight');
  await check('Visuals', 'Embedded battle backdrop decodes with nonzero dimensions', async () => {
    const result = await evaluate("(async()=>{const i=document.getElementById('battleSequenceImage');await i.decode();return {width:i.naturalWidth,height:i.naturalHeight,src:i.src.slice(0,23)};})()"); assert(result.width > 0 && result.height > 0, 'Battle backdrop did not decode'); return result;
  });
  await check('Initialization', 'Opening cutscene and dialogue reach an actionable player turn', async () => {
    await evaluate("new Promise(resolve=>{let n=0;const timer=setInterval(()=>{window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true}));window.dispatchEvent(new KeyboardEvent('keydown',{key:'Control',code:'ControlLeft',bubbles:true}));if(++n===500||(!document.querySelector('#rpg-save-controls [data-save]').disabled&&getComputedStyle(document.getElementById('dialogueOverlay')).display==='none')){clearInterval(timer);resolve();}},80);})");
    const result = await evaluate("({battleVisible:getComputedStyle(document.getElementById('battleUI')).display!=='none',commands:[...document.querySelectorAll('#menu button')].map(b=>({text:b.textContent,enabled:!b.disabled})),saveReady:!document.querySelector('#rpg-save-controls [data-save]').disabled})"); assert(result.battleVisible && result.saveReady && result.commands.some(b => b.enabled && b.text === 'Attack'), JSON.stringify(result)); return result;
  });
  await gatherDom('Battle ready'); await screenshot('05-battle-ready');
  await check('Visuals', 'Rendered battle portraits are visible and decoded', async () => {
    const result = await evaluate("[...document.querySelectorAll('#partyList img.portrait,#enemyList img.portrait')].map(i=>({src:i.currentSrc||i.src,complete:i.complete,width:i.naturalWidth,visible:getComputedStyle(i).visibility!=='hidden'&&i.getBoundingClientRect().width>0}))"); assert(result.length >= 7, `Expected four ally and three enemy portraits, got ${result.length}`); assert(result.every(i => i.complete && i.width > 0 && i.visible), JSON.stringify(result)); return result;
  });
  await check('Visuals', 'Active-turn highlight and HP/EN bars render', async () => {
    const result = await evaluate("({active:document.querySelectorAll('#partyList .is-active').length,bars:[...document.querySelectorAll('#partyList .bar,#enemyList .bar')].map(e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height}))})");
    assert(result.active >= 1 && result.bars.length >= 14 && result.bars.every(b=>b.width>0&&b.height>0),JSON.stringify(result));return result;
  });
  for (const [name,overlay,img,shot] of [['Niko Himura','allyHurtOverlay','allyHurtImg','06-ally-hurt'],['Itachi Himura','enemyHurtOverlay','enemyHurtImg','07-enemy-hurt']]) await check('Visuals', name+' hurt portrait appears and restores', async () => {
    await evaluate(`window.__initHurtDone=window.queueHurtFlash(${JSON.stringify(name)},2000);'started'`);
    try {
      await wait(120);
      const result = await evaluate(`(()=>{const e=document.getElementById(${JSON.stringify(overlay)}),i=document.getElementById(${JSON.stringify(img)}),r=e.getBoundingClientRect(),s=getComputedStyle(e);return {hidden:e.hidden,display:s.display,visibility:s.visibility,width:r.width,height:r.height,imageWidth:i.naturalWidth,source:i.src};})()`);
      await gatherDom('Hurt portrait '+name); await screenshot(shot);
      assert(!result.hidden&&result.display!=='none'&&result.visibility!=='hidden'&&result.width>0&&result.height>0&&result.imageWidth>0,JSON.stringify(result));
      return result;
    } finally {
      await evaluate('window.__initHurtDone');
      const restored=await evaluate(`(()=>{const i=[...document.querySelectorAll('#partyList img.portrait,#enemyList img.portrait')].find(i=>i.alt===${JSON.stringify(name)});return !!i&&getComputedStyle(i).visibility!=='hidden'&&i.getBoundingClientRect().width>0;})()`);
      assert(restored,'Original portrait was not restored after the hurt effect');
    }
  });
  stage = 'registered-music'; await evaluate("window.__initStage='registered-music'");
  for (const [key, source] of Object.entries(bgm)) await check('Music routing', key, async () => {
    await callCore(bindings, 'swapBattleBgm', [key, { ducked: false, ms: 0 }]);
    const expected = new URL(source, baseUrl + '/').href;
    await poll(`(()=>{const m=[...document.querySelectorAll('audio[data-bgm-key],video[data-bgm-key]')].find(m=>m.dataset.bgmKey===${JSON.stringify(key === 'battle' ? 'bgm' : key === 'postDialogue' ? 'postdialogue' : key)});return m&&m.src===${JSON.stringify(expected)}&&!m.error&&!m.paused&&!m.muted&&m.volume>0&&m.currentTime>.015;})()`, 6000);
    return { source, playback: 'real player advanced with nonzero volume' };
  }, ['LOCAL_BGM_KEYS.' + key]);
  await check('Music transitions','Dialogue ducking restores volume without restarting playback',async()=>{await callCore(bindings,'swapBattleBgm',['bgm',{ducked:false,ms:0}]);await wait(100);const before=await evaluate(`(()=>{const m=document.querySelector('[data-bgm-key="bgm"]');return {time:m.currentTime,volume:m.volume};})()`);await callCore(bindings,'duckBGM',[true]);await wait(80);const ducked=await evaluate(`(()=>{const m=document.querySelector('[data-bgm-key="bgm"]');return {time:m.currentTime,volume:m.volume};})()`);await callCore(bindings,'duckBGM',[false]);await wait(100);const restored=await evaluate(`(()=>{const m=document.querySelector('[data-bgm-key="bgm"]');return {time:m.currentTime,volume:m.volume};})()`);assert(ducked.volume<before.volume,'Dialogue does not lower volume');assert(Math.abs(restored.volume-before.volume)<.02,'Normal volume not restored');assert(restored.time>=before.time,'Ducking restarted the track');return {before,ducked,restored};});
  await check('Music transitions','Real player fade changes volume progressively and reaches target',async()=>{await callCore(bindings,'swapBattleBgm',['bgm',{ducked:false,ms:0}]);const result=await evaluate(`(async()=>{const player=window.__ytBgm;player.setVolume(80);const samples=[];window.__rpgInitBindings.fadePlayer(player,20,300);for(let i=0;i<8;i++){await new Promise(r=>setTimeout(r,60));samples.push(player.getVolume());}return samples;})()`);assert(result.at(-1)===20,'Fade misses target');assert(result.some(v=>v>20&&v<80),'Fade has no intermediate volume');assert(result.every((v,i)=>i===0||v<=result[i-1]),'Fade volume increases unexpectedly');return {samples:result};});
  await check('Music routing', 'Game-over music uses the real game-over player', async () => {
    const expected = new URL(bindings.get('NIKO_GAME_OVER_BGM_FILE_V57').value,baseUrl+'/').href;
    try {
      await callCore(bindings,'playNikoGameOverBgmV57');
      await poll(`(()=>{const m=[...document.querySelectorAll('video')].find(m=>m.src===${JSON.stringify(expected)});return m&&!m.paused&&!m.muted&&m.volume>0&&m.currentTime>0.015&&!m.error;})()`);
      return {source:expected,playback:'game-over player advanced'};
    } finally { await callCore(bindings,'fadeOutNikoGameOverBgmV57',[0]); await wait(100); }
  });
  await callCore(bindings, 'goSilentNow');
  stage = 'registered-sfx'; await evaluate("window.__initStage='registered-sfx'");
  for (const cue of sfx) await check('SFX routing', cue.key, async () => {
    const start = await evaluate('window.__initPlays.length');
    await callCore(bindings, 'playSfxKey', [cue.key]);
    await poll(`window.__initPlays.slice(${start}).some(e=>e.stage==='registered-sfx'&&e.status!=='pending')`, 6000);
    const events = await evaluate(`window.__initPlays.slice(${start}).filter(e=>e.stage==='registered-sfx')`);
    assert(events.some(e => e.src === cue.src && e.status === 'playing' && !e.muted && e.volume > 0), JSON.stringify(events)); return { source: cue.src, events };
  });
  stage = 'asset-probes'; await evaluate("window.__initStage='asset-probes'");
  console.log(`Discovered ${manifest.size} unique media/image references; checking HTTP, ranges, decoders and playback…`);
  const assets = [...manifest.values()];
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < assets.length) {
      const asset = assets[next++];
      await check(asset.kind === 'image' ? 'Image assets' : 'Audio/video assets', asset.name, async () => {
        const url = new URL(asset.url);
        assert(url.protocol === 'data:' || url.origin === baseUrl, 'External asset requires a separate connectivity check: ' + short(asset.url));
        const result = await evaluate(`window.__initProbe(${JSON.stringify(asset.url)},${JSON.stringify(asset.kind)})`, true);
        return { ...result, source: short(asset.url) };
      }, asset.references);
    }
  }));
  for (const [name,uri,kind] of [['corrupt image','data:image/png;base64,bm90IGFuIGltYWdl','image'],['corrupt audio','data:audio/mpeg;base64,bm90IGFuIG1wMw==','audio']]) await check('Verifier self-tests','Rejects '+name+' even when HTTP status is successful',async()=>{
    const result=await evaluate(`(async()=>{try{await window.__initProbe(${JSON.stringify(uri)},${JSON.stringify(kind)});return {rejected:false};}catch(error){return {rejected:true,name:error.name,message:error.message};}})()`,true);
    assert(result.rejected,'A corrupt payload was incorrectly accepted');
    assert(result.name==='EncodingError'||/decod|MediaError/i.test(result.message),'Rejected for an unrelated reason: '+JSON.stringify(result));return result;
  });
  stage = 'final';
  await check('Initialization', 'No uncaught startup or runtime exceptions', async () => { assert(!browserErrors.length, JSON.stringify(browserErrors)); return { uncaughtErrors: 0 }; });
  await check('Startup network', 'No failed startup asset responses are hidden', async () => {
    const declaredIcon = await evaluate("!!document.querySelector('link[rel*=icon]')");
    const failed = requests.filter(r => r.stage === 'startup' && r.status >= 400 && (declaredIcon || new URL(r.url).pathname !== '/favicon.ico'));
    const network = loadingFailures.filter(r => r.stage === 'startup' && !r.canceled && r.error !== 'net::ERR_ABORTED');
    assert(!failed.length && !network.length, JSON.stringify({ failed, network })); return { requests: requests.filter(r => r.stage === 'startup').length, ignoredAutomaticFavicon: !declaredIcon };
  });
  plays.push(...await evaluate('window.__initPlays'));
  const report = { generatedAt: new Date().toISOString(), passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks, inventory: assets.map(a => ({ name: a.name, url: short(a.url), kind: a.kind, references: a.references })), browserErrors, requests, loadingFailures, plays, screenshots: ['01-warning.png', '02-save-picker.png', '03-party-selection.png', '04-prefight.png', '05-battle-ready.png', '06-ally-hurt.png', '07-enemy-hurt.png'], notes: ['Runs actual game logic against the real server with a temporary database and an in-memory diagnostic bridge.', 'The browser output is muted; media element volume and decoding are tested normally.', 'Playback uses user interaction, without overriding browser autoplay policy.', 'Declared references are checked even when they are unused metadata; their reference labels distinguish them from active runtime cues.', 'Successful browser decoding/playback does not verify physical speakers or artistic appearance.'] };
  await writeReport(report);
  process.exitCode = report.failed ? 1 : 0;
} catch (error) {
  checks.push({ group: 'Test infrastructure', name: 'Runner completes', passed: false, error: errorText(error) });
  console.error(error.stack || error);
  await writeReport({ generatedAt: new Date().toISOString(), passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks, browserErrors, requests, loadingFailures, notes: ['Initialization did not complete. Dependent checks were not counted as passing.'] }).catch(() => {});
  process.exitCode = 1;
} finally {
  page?.socket.close();
  if (browser) { try { await browser.call('Browser.close'); } catch {} browser.socket.close(); }
  if(proxyServer){proxyServer.closeAllConnections();await new Promise(done=>proxyServer.close(done));}
  for (const child of [browserProcess, serverProcess]) if (child && child.exitCode === null && child.signalCode === null) { child.kill(); await Promise.race([new Promise(done => child.once('exit', done)), wait(3000)]); }
  await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
}
async function writeReport(report) {
  await mkdir(reportDir, { recursive: true });
  await writeFile(resolve(reportDir, 'initialization.json'), JSON.stringify(report, null, 2) + '\n');
  const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const groups = [...new Set(report.checks.map(c => c.group))];
  const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>RPG initialization and asset tests</title><style>body{font:16px/1.5 system-ui;max-width:1200px;margin:32px auto;padding:0 20px;background:#101426;color:#e7e9f7}.pass{color:#7be5a0}.fail{color:#ff9898}details{border:1px solid #39407a;border-radius:8px;padding:10px;margin:8px 0}summary{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px}a{color:#a9c3ff}.shots{display:flex;gap:12px;flex-wrap:wrap}.shots img{width:280px;max-width:100%;border:1px solid #39407a}</style><h1>Initialization, music, SFX and visuals</h1><p><strong class="pass">${report.passed} passed</strong> · <strong class="fail">${report.failed} failed</strong></p><p>${escape(report.generatedAt)}</p>${(report.notes || []).map(note => `<p>${escape(note)}</p>`).join('')}<div class="shots">${(report.screenshots || []).map(src => `<a href="${src}"><img src="${src}" alt="${src}"></a>`).join('')}</div>${groups.map(group => { const rows = report.checks.filter(c => c.group === group); return `<h2>${escape(group)} · ${rows.filter(c => c.passed).length}/${rows.length} passed</h2>${rows.map(c => `<details ${c.passed ? '' : 'open'}><summary class="${c.passed ? 'pass' : 'fail'}">${c.passed ? 'PASS' : 'FAIL'} · ${escape(c.name)}</summary><pre>${escape(c.error || JSON.stringify(c.evidence, null, 2))}</pre>${c.references?.length ? `<pre>${escape(c.references.join('\n'))}</pre>` : ''}</details>`).join('')}`; }).join('')}</html>`;
  await writeFile(resolve(reportDir, 'initialization-report.html'), html);
  for (const group of groups) { const rows = report.checks.filter(c => c.group === group); console.log(`${group}: ${rows.filter(c => c.passed).length}/${rows.length} passed`); }
  console.log(`\nInitialization: ${report.passed} passed, ${report.failed} failed.\nReport: ${resolve(reportDir, 'initialization-report.html')}`);
}

}

// Expanded coverage: item contracts, party interactions, follow-ups, probability,
// compatibility and stress. These use real mechanics with presentation isolated.
async function runEmbeddedSuite(id,install){
  const {createServer}=await import('node:http');const {readFile,writeFile,mkdir}=await import('node:fs/promises');
  const {launchTestBrowser}=await import('./browser-automation.mjs');
  const root=PROJECT_ROOT,out=process.env.RPG_EXPANDED_REPORT_DIR||absolutePath(root,'test-results');await mkdir(out,{recursive:true});
  const source=await readFile(absolutePath(root,'index.html'),'utf8'),anchor='\n})();\n\n// === global error fallbacks ===';
  if(!source.includes(anchor))throw Error('Game closure anchor missing');
  const html=source.replace(anchor,`\nwindow.addEventListener('DOMContentLoaded',()=>(${install.toString()})(),{once:true});\n${anchor}`);
  const server=createServer(async(req,res)=>{try{const path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);if(path==='/'){res.setHeader('Content-Type','text/html');return res.end(html);}if(path==='/save-system.js'){res.setHeader('Content-Type','text/javascript');return res.end('window.RpgSaves=new Proxy({}, {get:(_,key)=>key==="install"?(adapter=>window.__expandedAdapter=adapter):()=>key==="begin"?true:undefined});');}if(path.startsWith('/api/')){res.writeHead(403);return res.end();}const file=absolutePath(root,'.'+path);if(!file.startsWith(root+'/'))throw Error('Invalid path');res.setHeader('Content-Type',/\.js$/.test(file)?'text/javascript':/\.css$/.test(file)?'text/css':'application/octet-stream');res.end(await readFile(file));}catch{res.writeHead(404);res.end();}});
  let browser;const errors=[];
  try{await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await launchTestBrowser({onEvent(method,p){if(method==='Runtime.exceptionThrown')errors.push(p.exceptionDetails);}});await browser.page.call('Page.navigate',{url:`http://127.0.0.1:${server.address().port}`});
    const result=await browser.page.call('Runtime.evaluate',{expression:'window.__expandedTests.run()',awaitPromise:true,returnByValue:true});if(result.exceptionDetails)throw Error(JSON.stringify(result.exceptionDetails));
    const report=result.result.value;report.browser=browser.selected.name;for(const error of errors)report.results.push({group:'Infrastructure',name:'Uncaught browser exception',passed:false,error:JSON.stringify(error)});
    await emitExpandedReport(id,report,out);
  }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
async function emitExpandedReport(id,report,out=process.env.RPG_EXPANDED_REPORT_DIR){
  report.generatedAt=new Date().toISOString();report.passed=report.results.filter(r=>r.passed&&!r.skipped).length;report.failed=report.results.filter(r=>!r.passed&&!r.skipped).length;report.skipped=report.results.filter(r=>r.skipped).length;
  const {writeFile,mkdir}=await import('node:fs/promises');await mkdir(out,{recursive:true});await writeFile(absolutePath(out,id+'.json'),JSON.stringify(report,null,2)+'\n');
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  await writeFile(absolutePath(out,id+'.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><title>${esc(id)} results</title><style>body{background:#101426;color:#e7e9f7;font:16px/1.5 system-ui;padding:24px}details{padding:12px;border:1px solid #53618c;margin:8px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere}.pass{color:#82e4ab}.fail{color:#ff9f9f}</style><h1>${esc(id)}</h1><p>${report.passed} passed · ${report.failed} failed · ${report.skipped} pending/skipped</p><p>${esc(report.scope)}</p>${report.results.map(r=>`<details ${r.passed?'':'open'}><summary class="${r.passed?'pass':r.skipped?'':'fail'}">${r.skipped?'SKIP':r.passed?'PASS':'FAIL'} ${esc(r.group)} / ${esc(r.name)}</summary><pre>${esc(JSON.stringify(r,null,2))}</pre></details>`).join('')}`);
  console.log(`${id}: ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`);for(const r of report.results.filter(r=>!r.passed))console.log(`${r.skipped?'SKIP':'FAIL'} ${r.group} / ${r.name}: ${r.error||r.reason}`);process.exitCode=report.failed?1:0;
}
async function testExpandedMechanics(){
  function install(){
    const results=[],clone=v=>JSON.parse(JSON.stringify(v));let assertions=[],messages=[],actions=0,roll=.8;
    const assert=(ok,label)=>{if(!ok)throw Error(label);};const eq=(actual,expected,label)=>{assertions.push({label,actual,expected});assert(Object.is(actual,expected),`${label}: expected ${expected}, got ${actual}`);};
    const same=(a,b,label)=>eq(JSON.stringify(a),JSON.stringify(b),label);
    async function test(group,name,fn){assertions=[];try{const evidence=await fn();results.push({group,name,passed:true,assertions,evidence});}catch(e){results.push({group,name,passed:false,assertions,error:String(e),log:messages.slice(-10)});}}
    log=m=>messages.push(String(m?.text||m));renderBars=()=>{};renderCommandMenu=()=>{};sayOne=()=>{};speakFollowupLines=()=>{};playSfxKey=()=>{};queueHurtFlash=()=>{};swapBattleBgm=()=>{};setTurnBanner=()=>{};advanceAfterPlayerAction=()=>actions++;advanceTurn=()=>actions++;
    const originalRandom=Math.random;Math.random=()=>roll;
    function fixture(names=['Niko Himura','Toshiro Yoshikawa','Miya Hagimoto','Hotaru Minami']){
      resetBattleProgress();roll=.8;messages=[];actions=0;ENEMY_DEBUG_ATK_BONUS=0;
      party=names.map(n=>buildStatsFromTiers(n,normalizeTiers(ROSTER[n])));party.forEach(p=>{p.hp=1000;p.maxHP=10000;p.en=500;p.maxEN=2000;p.baseAcc=2;p._turnStarted=true;p.surpriseReady=false;p.status.reflectAll=0;});
      enemies=[makeEnemy('Training Target A',10000,100,100,0,1000,'high'),makeEnemy('Training Target B',10000,100,100,0,1000,'high'),makeEnemy('Soulless Survivor',40000,445,225,0,2100,'high')];enemies.forEach(e=>e.hp=e.maxHP=10000);
      phase='player';_inPlayerPhase=true;currentActorIdx=0;_actedThisPhase=party.map(()=>false);_actionInFlight=false;_battleDialogueLockDepth=0;inSpecialDialogue=false;_inPrefightFlow=false;_pickCtx=null;followCtx=null;pendingSkill=null;selectedAction=null;bag=defaultBag();
      UI.battleUI.style.display='';UI.overlay.style.display='none';UI.selectPanel.style.display='none';UI.menu.replaceChildren();UI.subMenu.replaceChildren();window.__battleDialogueHardLockV72=false;
    }
    const itemKeys=['noodles','bar','lighter','melon','cprotein','detox','relaxant','hydrant','finalgift','bugpatch','steroid','shield','wish','MyriadTs'];
    function prepare(item){const ally=party[1];if(item.key==='wish'){ally.alive=false;ally.hp=0;ally.en=0;}if(item.key==='detox')party.forEach(p=>Object.assign(p.status,{atkDown:3,defDown:3,defCrash:3}));if(item.key==='relaxant')Object.assign(ally.status,{rage:2,despair:2,brainwash:2});if(item.key==='hydrant')ally.status.burn=3;if(item.key==='bugpatch')enemies.forEach(e=>Object.assign(e.status,{atkUp:3,defUp:3,accUp:3,spdUp:3}));}
    function use(item){if(item.target==='allAllies'){if(useItemAllAllies(item))advanceAfterPlayerAction();}else if(item.target==='allEnemies'){if(useItemAllEnemies(item))advanceAfterPlayerAction();}else onItemTargetChosen(item,item.target,item.target==='ally'?1:0);}
    function validUnits(){for(const u of [...party,...enemies]){assert(Number.isFinite(u.hp)&&u.hp>=0&&u.hp<=u.maxHP,'HP remains finite and bounded: '+u.name);assert(Number.isFinite(u.en)&&u.en>=0&&u.en<=u.maxEN,'Energy remains finite and bounded: '+u.name);}}
    async function run(){
      fixture();same(bag.map(i=>i.key),itemKeys,'Every current item has an explicit contract');
      for(const key of itemKeys){
        await test('Items: exact effects',key,()=>{
          fixture();const item=bag.find(i=>i.key===key);prepare(item);const before=clone({party,enemies}),qty=item.qty;use(item);eq(item.qty,qty-1,'Exactly one item consumed');eq(actions,1,'Exactly one action consumed');const a=party[1],old=before.party[1];
          if(key==='noodles')eq(a.hp,old.hp+300,'Heals exactly 300 HP');if(key==='bar')eq(a.en,old.en+100,'Restores exactly 100 EN');if(key==='cprotein')eq(a.en,a.maxEN,'Full EN');
          if(key==='lighter')eq(enemies[0].hp,before.enemies[0].hp-400,'Deals exactly 400 damage');if(key==='MyriadTs')enemies.forEach((e,i)=>eq(e.hp,before.enemies[i].hp-500,'500 guaranteed damage to '+e.name));
          if(key==='melon')party.forEach((p,i)=>eq(p.hp,before.party[i].hp+200,'200 HP to every ally'));
          if(key==='detox')party.forEach(p=>{for(const k of ['atkDown','defDown','defCrash'])eq(p.status[k],0,'Cleanses '+k);eq(p.stunTurns||0,0,'Cleanses stun');});
          if(key==='relaxant')for(const k of ['rage','despair','brainwash'])eq(a.status[k],0,'Cures '+k);
          if(key==='hydrant')eq(a.status.burn,0,'Cures burn');if(key==='steroid')eq(a.status.atkUp,6,'Six turns ATK up');if(key==='shield'){eq(a.status.endureEP,1,'One enemy phase duration');applyDamageToAlly(a,20000);eq(a.hp,1,'First lethal hit is survived with one HP');eq(a.status.endureEP,0,'Survival consumes the shield');}
          if(key==='wish'){eq(a.alive,true,'Revives fallen ally');eq(a.hp,2500,'25 percent HP');eq(a.en,500,'25 percent EN');}
          if(key==='finalgift')party.forEach(p=>{eq(p.hp,p.maxHP,'Full team HP');eq(p.en,p.maxEN,'Full team EN');});
          if(key==='bugpatch')enemies.forEach(e=>{for(const k of ['atkUp','defUp','accUp','spdUp'])eq(e.status[k],0,'Purges '+k);});validUnits();
        });
        await test('Items: empty inventory',key,()=>{fixture();const item=bag.find(i=>i.key===key);prepare(item);item.qty=0;const before=clone({party,enemies});use(item);eq(item.qty,0,'Quantity never negative');eq(actions,0,'No action consumed');same({party,enemies},before,'No effect without inventory');});
        await test('Items: selection and cancellation',key,()=>{fixture();const item=bag.find(i=>i.key===key);prepare(item);const before=clone({party,enemies,bag});renderItemMenu();same({party,enemies,bag},before,'Opening menu does not apply item');eq(actions,0,'Opening/cancelling menu is free');selectedItemKey=item.key;if(['ally','enemy'].includes(item.target)){renderItemTargetSelect(item.target,item);same({party,enemies,bag},before,'Target picker does not consume item');}const back=[...UI.subMenu.querySelectorAll('button')].find(b=>/^Back$/.test(b.textContent.trim()));assert(back,'Back control exists');back.click();eq(actions,0,'Back consumes no action');same({party,enemies,bag},before,'Back preserves inventory and stats');});
        await test('Items: wrong/dead targets and bounds',key,()=>{fixture();const item=bag.find(i=>i.key===key);prepare(item);if(item.target==='ally'&&key!=='wish'){party[1].alive=false;party[1].hp=0;const qty=item.qty;use(item);eq(item.qty,qty,'Cannot spend item on dead ally');eq(actions,0,'Rejected target consumes no action');}else{party.forEach(p=>{if(p.alive){p.hp=p.maxHP-1;p.en=p.maxEN-1;}});use(item);validUnits();}});
      }
      for(const key of ['relaxant','hydrant','wish','detox'])await test('Items: ineligible target',key,()=>{fixture();const item=bag.find(i=>i.key===key),qty=item.qty;use(item);eq(item.qty,qty,'No eligible ailment/death does not consume item');eq(actions,0,'No eligible effect does not consume action');});
      for(const key of ['lighter','MyriadTs','bugpatch'])await test('Items: observer protection',key,()=>{fixture();const boss=enemies.find(isSS),minion=makeEnemy('Itachi Himura',7500,210,10,0,1000,'high');minion._summonedBySS=true;enemies.push(minion);const item=bag.find(i=>i.key===key);prepare(item);const hp=boss.hp,up=boss.status.atkUp;selectedAction='item';selectedItemKey=key;if(key==='lighter'){renderItemTargetSelect('enemy',item);const button=[...UI.subMenu.querySelectorAll('button')].find(b=>b.textContent.includes('Soulless Survivor'));assert(button?.disabled,'Observer target disabled');}else use(item);eq(boss.hp,hp,'Observer HP preserved');eq(boss.status.atkUp,up,'Observer buffs preserved');});
      const others=Object.keys(ROSTER).filter(n=>n!=='Niko Himura'),lineups=[];for(let a=0;a<others.length;a++)for(let b=a+1;b<others.length;b++)for(let c=b+1;c<others.length;c++)lineups.push(['Niko Himura',others[a],others[b],others[c]]);
      for(const names of lineups){
        await test('Party combinations: initialization',names.join(' + '),()=>{fixture(names);eq(new Set(party.map(p=>p.name)).size,4,'Four distinct party members');assert(party.every(p=>p.status&&p.alive),'Every party member initializes alive with statuses');validUnits();});
        for(const name of names){const keys={ 'Niko Himura':'science','Towa Himura':'glory','Miya Hagimoto':'cheatcode','Hotaru Minami':'unity','Akio Mamoru':'akioCollab','Toshiro Yoshikawa':'toshUltimateHack'};
          await test('Party combinations: team interactions',names.join(', ')+' / '+name,()=>{fixture(names);currentActorIdx=names.indexOf(name);party[currentActorIdx].en=party[currentActorIdx].maxEN=100000;const skill=getActorSkills(party[currentActorIdx]).find(s=>s.key===keys[name]);assert(skill,'Explicit support skill exists: '+keys[name]);const identities=party.map(p=>p.name),bases=party.map(p=>p.baseAtk);useSkill(skill,null);eq(actions,1,'Team skill consumes exactly one action');same(party.map(p=>p.name),identities,'Team skill preserves party identity');same(party.map(p=>p.baseAtk),bases,'Team effects do not overwrite base attack');validUnits();});
        }
        if(names.includes('Miya Hagimoto'))await test('Party combinations: mentor dependency',names.join(', '),()=>{fixture(names);currentActorIdx=names.indexOf('Miya Hagimoto');const user=party[currentActorIdx],target=enemies[0],skill=getActorSkills(user).find(s=>s.key==='malware'),mult=names.includes('Toshiro Yoshikawa')?3.4:1.8;const expected=Math.max(1,Math.round(Math.max(1,(user.baseAtk+50)*mult-target.baseDef)*1.18)),before=target.hp;useSkill(skill,target);eq(before-target.hp,expected,'Mentor multiplier depends on actual selected party');});
      }
      for(const initiator of ['Niko Himura','Towa Himura','Toshiro Yoshikawa'])for(const partner of Object.keys(ROSTER).filter(n=>n!==initiator))for(const branch of [.2,.8])await test('Follow-ups: every pairing',initiator+' → '+partner+' / roll '+branch,()=>{
        const names=[...new Set([initiator,partner,'Niko Himura','Miya Hagimoto','Hotaru Minami'])].slice(0,4);fixture(names);roll=branch;const p=party[1];p.hp=5000;const hp=party.map(a=>a.hp),en=party.map(a=>a.en),enemyHP=enemies[0].hp;followCtx={initiatorIdx:0,partnerIdx:1,step:'target'};performFollowAttack(0);eq(actions,1,'Follow-up ends exactly one action');assert(!followCtx,'Follow-up context cleared');
        if(initiator==='Niko Himura'&&partner==='Towa Himura'){eq(enemies[0].hp,enemyHP,'Support pairing skips extra attack');eq(party[0].status.teamTriple,3,'Niko gains three triple-damage actions');eq(p.hp,4600,'Towa pays exactly 400 HP');}else{const chance=branch<.5?(partner==='Akio Mamoru'?2:partner==='Hotaru Minami'?3:1):1;const base=Math.max(1,Math.round(Math.max(1,Math.round((p.baseAtk+50)*(initiator==='Toshiro Yoshikawa'&&partner==='Miya Hagimoto'?1.5:1))-100)*(.7+.6*branch)));eq(enemyHP-enemies[0].hp,base*chance,'Partner damage and branch multiplier');}
        if(partner==='Miya Hagimoto'){const amount=initiator==='Toshiro Yoshikawa'?35:15;party.forEach((a,i)=>eq(a.en,en[i]+amount,'Correct team EN bonus'));if(initiator==='Toshiro Yoshikawa')party.forEach(a=>assert(a.status.atkUp>0,'Toshiro/Miya grants team ATK up'));}
        if(initiator==='Towa Himura'&&partner==='Niko Himura')eq(party[0].hp,hp[0]+200,'Niko heals Towa for 200');
        if(initiator==='Toshiro Yoshikawa'&&partner==='Towa Himura')party.forEach((a,i)=>eq(a.hp,hp[i]+100,'Towa heals every ally for 100'));
        if(partner==='Toshiro Yoshikawa')eq(enemies[0].stunTurns||0,branch<.5?1:0,'Toshiro Crash follows its chance branch');
        if(initiator==='Toshiro Yoshikawa'&&partner==='Niko Himura')enemies.forEach(e=>eq(e.status.despair||0,branch<.5?2:0,'Niko team Despair follows chance branch'));
      });
      for(const initiator of ['Niko Himura','Towa Himura','Toshiro Yoshikawa'])for(const partner of Object.keys(ROSTER).filter(n=>n!==initiator))await test('Follow-ups: defensive option',initiator+' → '+partner,()=>{fixture([initiator,partner]);followCtx={initiatorIdx:0,partnerIdx:1,step:'choice'};applyFollowDefBoost();eq(party[1].status.defInsane,1,'Selected partner gains one turn Insane DEF');eq(actions,1,'Defense follow-up completes once');});
      for(const who of ['initiator','partner'])await test('Follow-ups: incapacitation',who,()=>{fixture();followCtx={initiatorIdx:0,partnerIdx:1,step:'target'};party[who==='initiator'?0:1].stunTurns=1;const hp=enemies[0].hp;performFollowAttack(0);eq(enemies[0].hp,hp,'Stunned participant cannot attack');});
      function seeded(seed){let s=seed>>>0;return()=>{s=(Math.imul(s,1664525)+1013904223)>>>0;return s/4294967296;};}
      async function probability(name,p,trial){await test('Probabilities: statistical checks',name,()=>{fixture();const rng=seeded(74117),n=20000;Math.random=rng;let hit=0;const realMenu=renderFollowPartnerMenu;renderFollowPartnerMenu=()=>{};try{for(let i=0;i<n;i++)hit+=trial()?1:0;}finally{renderFollowPartnerMenu=realMenu;Math.random=()=>roll;}const tolerance=6*Math.sqrt(n*p*(1-p))+2;assert(Math.abs(hit-n*p)<=tolerance,`Observed ${hit}/${n}, expected ${p}, tolerance ${tolerance}`);return {seed:74117,trials:n,successes:hit,expectedRate:p,tolerance};});}
      await probability('Normal follow-up rate is 4%',.04,()=>maybeTriggerFollowUp(0));
      await probability('Boosted follow-up rate is 80%',.8,()=>{party[0].status.followBoost=3;return maybeTriggerFollowUp(0);});
      await probability('Phase power-up critical floor is 40%',.4,()=>{enemies[2]._phase2=true;return critRoll(enemies[2],.1);});
      await test('AI distribution','Healthy unbuffed boss action distribution',()=>{fixture();const boss=enemies[2];boss.en=boss.maxEN;boss.hp=boss.maxHP=40000;const rng=seeded(97),observed={};Math.random=rng;for(let n=0;n<20000;n++){const action=chooseBossAction(boss);observed[action]=(observed[action]||0)+1;}Math.random=()=>roll;const weights={trial1:.2,trial2:.2,mind:.15,aoe:.15,explosiveCat:.1,single:.2};for(const [key,p] of Object.entries(weights))assert(Math.abs((observed[key]||0)-20000*p)<6*Math.sqrt(20000*p*(1-p))+2,'AI probability differs: '+key);assert(Object.keys(observed).every(k=>k in weights),'No unexpected full-resource actions');return {seed:97,samples:20000,observed,expected:weights};});
      for(const edit of ['old schema','missing flags','unknown character','missing inventory','negative inventory','missing enemy list','invalid actor'])await test('Save compatibility: rejected checkpoints',edit,()=>{fixture();selectedNames=new Set(party.slice(1).map(p=>p.name));const adapter=window.__expandedAdapter,state={...clone(adapter.snapshot()),schemaVersion:2,battleId:'expanded',sequence:0,turn:1},saved={state,inventory:clone(adapter.inventory())};if(edit==='old schema')state.schemaVersion=1;if(edit==='missing flags')delete state.flags;if(edit==='unknown character')state.party[0].name='Unknown';if(edit==='missing inventory')saved.inventory=[];if(edit==='negative inventory')saved.inventory[0].quantity=-1;if(edit==='missing enemy list')delete state.enemies;if(edit==='invalid actor')state.flags.currentActorIdx=99;const before=clone({party,enemies,bag});let rejected=false;try{adapter.restore(saved);}catch{rejected=true;}assert(rejected,'Invalid checkpoint must be rejected');same({party,enemies,bag},before,'Rejection is atomic');});
      await test('Save compatibility: unusual state','Statuses, depleted inventory, defeated enemies, cooldowns and notebook',()=>{fixture();selectedNames=new Set(party.slice(1).map(p=>p.name));party[1].status.firewall=3;party[2].status.reflectAll=2;party[3].status.teamTriple=3;party[0].surpriseCounter=2;bag.forEach(i=>i.qty=0);enemies[1].alive=false;enemies[1].hp=0;towaNotebookArmed=true;const adapter=window.__expandedAdapter,state={...clone(adapter.snapshot()),schemaVersion:2,battleId:'unusual',sequence:0,turn:2},inventory=clone(adapter.inventory());adapter.restore({state,inventory});same(party,state.party,'Party state restored exactly');same(enemies,state.enemies,'Enemy state restored exactly');assert(towaNotebookArmed,'Notebook armed state restored');assert(bag.every(i=>i.qty===0),'Zero inventory preserved');});
      await test('Stress: long calculations','100000 calculations remain bounded and do not mutate stats',()=>{fixture();const base=party.map(p=>p.baseAtk),start=performance.now();for(let n=0;n<100000;n++){const d=damageFormula(party[n%party.length],enemies[0],2.4);assert(Number.isFinite(d)&&d>=1,'Damage finite');}same(party.map(p=>p.baseAtk),base,'No accumulated ATK mutation');return {calculations:100000,ms:performance.now()-start};});
      await test('Stress: large enemy roster','500 targets receive exactly one AoE item hit',()=>{fixture();enemies=Array.from({length:500},(_,i)=>makeEnemy('Load target '+i,5000,100,100,0,1000,'high'));const hp=enemies.map(e=>e.hp),item=bag.find(i=>i.key==='MyriadTs');use(item);enemies.forEach((e,i)=>eq(e.hp,hp[i]-500,'Each target hit once'));eq(actions,1,'One action regardless of target count');});
      Math.random=originalRandom;return {results,scope:'Explicit item contracts, all legal four-character party lineups, every supported follow-up pairing, seeded probability/AI distributions, checkpoint compatibility and stress. Presentation and scheduling are isolated; separate journey/UI suites retain real scheduling.'};
    }
    window.__expandedTests={run};
  }
  await runEmbeddedSuite('extended',install);
}

async function testApiResilience(){
  const temporary=await makeTemporaryDirectory(absolutePath(temporaryRoot(),'rpg-api-tests-'));let server;const results=[];
  const assert=(ok,label)=>{if(!ok)throw Error(label);};
  async function test(name,fn){try{const evidence=await fn();results.push({group:'HTTP API, persistence and concurrency',name,passed:true,evidence});}catch(error){results.push({group:'HTTP API, persistence and concurrency',name,passed:false,error:String(error)});}}
  const cookie='rpg_player='+'a'.repeat(64),other='rpg_player='+'b'.repeat(64);let serial=0;
  function checkpoint(){const battleId='api-'+(++serial);return {battleId,decisions:[],state:{schemaVersion:2,battleId,sequence:0,turn:1,party:[{name:'Niko Himura',hp:100,en:100,alive:true,_turnStarted:true,guarding:false,status:{}}],enemies:[{name:'Soulless Survivor',hp:40000,en:2000,status:{}}],flags:{phase:'player',_inPlayerPhase:true,currentActorIdx:0,_actedThisPhase:[false]}},inventory:[{item_id:'noodles',quantity:3}]};}
  async function request(path,{method='GET',body,headers={},identity=cookie}={}){const r=await fetch(server.url+path,{method,headers:{Cookie:identity,...(body!==undefined?{'Content-Type':'application/json'}:{}),...headers},body:body===undefined?undefined:typeof body==='string'?body:JSON.stringify(body)});const text=await r.text();let value;try{value=JSON.parse(text);}catch{value=text;}return {status:r.status,value};}
  const put=(payload,slot=1)=>request('/api/saves/'+slot,{method:'PUT',body:payload});
  try{server=await startSaveServer(temporary);
    for(const [label,body,headers,status] of [['Malformed JSON','{',{},400],['Wrong content type','{}',{'Content-Type':'text/plain'},415],['Null payload','null',{},400],['Array payload','[]',{},400]])await test(label,async()=>{const r=await request('/api/saves/1',{method:'PUT',body,headers});assert(r.status===status,'Expected '+status+', got '+r.status);});
    for(const [name,edit]of [['Old schema',p=>p.state.schemaVersion=1],['Missing flags',p=>delete p.state.flags],['Unknown actor index',p=>p.state.flags.currentActorIdx=99],['Negative HP',p=>p.state.party[0].hp=-1],['HP exceeds maximum',p=>{p.state.party[0].maxHP=100;p.state.party[0].hp=101;}],['Duplicate inventory keys',p=>p.inventory.push({...p.inventory[0]})],['Negative quantity',p=>p.inventory[0].quantity=-1],['Fractional quantity',p=>p.inventory[0].quantity=.5],['Invalid turn',p=>p.state.turn=0],['Enemy-turn checkpoint',p=>p.state.flags.phase='enemy'],['Already-used turn',p=>p.state.flags._actedThisPhase[0]=true],['Missing status object',p=>delete p.state.party[0].status],['Non-numeric energy',p=>p.state.party[0].en='100'],['Wrong battle identity',p=>p.state.battleId='different']])await test('Validation: '+name,async()=>{const original=checkpoint();assert((await put(original,2)).status===200,'Seed checkpoint saved');const invalid=checkpoint();edit(invalid);const r=await put(invalid,2);assert(r.status>=400,'Malformed state must be rejected');const saved=await request('/api/saves/2');assert(saved.value.state.battleId===original.battleId,'Failed write leaves old slot intact');});
    await test('Oversized JSON request is rejected',async()=>{const r=await request('/api/saves/1',{method:'PUT',body:JSON.stringify({padding:'x'.repeat(8388609)})});assert(r.status===413,'Expected 413, got '+r.status);});
    await test('Cross-origin writes are rejected',async()=>{const r=await request('/api/saves/1',{method:'PUT',body:checkpoint(),headers:{Origin:'https://untrusted.invalid'}});assert(r.status===403,'Expected 403');});
    await test('Database and backend source paths are not served',async()=>{for(const path of ['/data/game.sqlite','/server/store.js','/server/schema.sql','/.env','/test/anything.js'])assert((await request(path)).status===404,'Private path exposed: '+path);});
    await test('Slot 6 cannot be manually overwritten via HTTP',async()=>assert((await put(checkpoint(),6)).status===400,'Protected slot must reject PUT'));
    await test('Other player cannot load existing manual slot',async()=>{assert((await put(checkpoint(),1)).status===200,'Seed saved');const r=await request('/api/saves/1',{identity:other});assert(r.status===200&&r.value===null,'Player isolation failed');});
    await test('Same decision retry is idempotent through HTTP',async()=>{const p=checkpoint();await put(p,3);const decision={id:'retry-'+p.battleId,sequenceNumber:1,turnNumber:1,actorId:'Niko Himura',actionType:'guard',targets:[],result:{}};const payload={battleId:p.battleId,decisions:[decision]};const responses=await Promise.all([request('/api/battles/events',{method:'POST',body:payload}),request('/api/battles/events',{method:'POST',body:payload})]);assert(responses.every(r=>r.status===200),'Exact retry rejected');const h=await request('/api/history');assert(h.value.find(b=>b.id===p.battleId).decisions.length===1,'Retry duplicated decision');});
    await test('Concurrent conflicting decisions accept only one',async()=>{const p=checkpoint();await put(p,3);const responses=await Promise.all([0,1].map(n=>request('/api/battles/events',{method:'POST',body:{battleId:p.battleId,decisions:[{id:p.battleId+'-'+n,sequenceNumber:1,turnNumber:1,actorId:'Niko Himura',actionType:n?'attack':'guard',targets:[],result:{}}]}})));assert(responses.filter(r=>r.status===200).length===1,'Exactly one conflict winner');assert(responses.filter(r=>r.status===400).length===1,'Conflicting retry rejected');});
    await test('Two-client slot overwrites keep state and inventory atomic',async()=>{const payloads=Array.from({length:12},(_,i)=>{const p=checkpoint();p.state.party[0].hp=50+i;p.inventory[0].quantity=i;return p;});const responses=await Promise.all(payloads.map(p=>put(p,4)));assert(responses.every(r=>r.status===200),'Serialized last-writer-wins writes complete');const saved=(await request('/api/saves/4')).value,source=payloads.find(p=>p.battleId===saved.state.battleId);assert(source,'Final state belongs to an actual writer');assert(saved.inventory[0].quantity===source.inventory[0].quantity,'Inventory cannot be mixed with another write');assert(saved.state.party[0].hp===source.state.party[0].hp,'HP matches same snapshot');return {writers:12,policy:'last accepted write wins atomically'};});
    await test('Opening autosave survives server restart',async()=>{const p=checkpoint();assert((await request('/api/autosave',{method:'POST',body:p})).status===200,'Autosave accepted');await releaseOwned(server.child);server=await startSaveServer(temporary);const saved=(await request('/api/saves/6')).value;assert(JSON.stringify(saved.state)===JSON.stringify(p.state),'State changed across restart');assert(saved.inventory[0].quantity===3,'Inventory survives restart');});
    await test('Corrupted stored JSON fails safely without crashing server',async()=>{const p=checkpoint();await put(p,5);await releaseOwned(server.child);const {createDatabase}=await import('../server/database.js');const db=await createDatabase({env:{},localPath:absolutePath(temporary,'save-flow-postgres')});const c=await db.connect();try{const row=(await c.query('SELECT id FROM saves WHERE player_id=$1 AND slot=5',[cookie.slice('rpg_player='.length)])).rows[0];await c.query('UPDATE payload_chunks SET data=$1 WHERE payload_id=$2 AND part=0',['{',row.id]);}finally{c.release();await db.close();}server=await startSaveServer(temporary);assert((await request('/api/saves/5')).status>=400,'Corrupted state cannot load');assert((await request('/api/saves/6')).status===200,'Other valid slots remain accessible');});
    await test('Completed battle rejects new decisions after restart',async()=>{const p=checkpoint();await put(p,5);assert((await request('/api/battles/events',{method:'POST',body:{battleId:p.battleId,decisions:[],outcome:'escaped'}})).status===200,'Completion recorded');const r=await request('/api/battles/events',{method:'POST',body:{battleId:p.battleId,decisions:[{id:'late-'+p.battleId,sequenceNumber:1,turnNumber:1,actorId:'Niko Himura',actionType:'guard',targets:[]}]}});assert(r.status===400,'Completed battle cannot keep accepting combat');});
  }finally{if(server)await releaseOwned(server.child);await removeTemporaryDirectory(temporary,{recursive:true,force:true});}
  await emitExpandedReport('api',{results,scope:'Real HTTP server: malformed and oversized requests, ownership, concurrent writers, transaction atomicity and disk-backed restart recovery.'});
}

// Isolated same-origin test proxy. Each page case gets its own backend identity;
// actual API, save-system.js and PostgreSQL code remain unchanged.
async function withIntegrationBrowser(id,documentFactory,task){
  const {createServer}=await import('node:http');const {createHash}=await import('node:crypto');const {readFile}=await import('node:fs/promises');const {launchTestBrowser}=await import('./browser-automation.mjs');
  const backend=process.env.RPG_TEST_URL;if(!backend)throw Error('Integration suite requires its temporary server');
  const original=await readFile(absolutePath(PROJECT_ROOT,'index.html'),'utf8');
  const server=createServer(async(req,res)=>{try{const uri=new URL(req.url,'http://localhost');if(uri.pathname==='/'){res.setHeader('Content-Type','text/html');return res.end(documentFactory(original));}
    if(id==='journeys'&&uri.pathname==='/save-system.js'){
      const source=await readFile(absolutePath(PROJECT_ROOT,'save-system.js'),'utf8');
      const instrumented=source.replace('  window.RpgSaves = {', '  window.__saveReadinessProbe = () => ({session:!!session,ready,readyGeneration,enemyDepth,busy,outcome,adapterReady:adapter.isReady(),canSave:canSave()});\n  window.RpgSaves = {');
      res.setHeader('Content-Type','text/javascript');return res.end(instrumented);
    }
    const headers={...req.headers};delete headers.host;delete headers.origin;delete headers['content-length'];const ref=new URL(req.headers.referer||'http://localhost');const identity=ref.searchParams.get('case')||'shared';headers.cookie='rpg_player='+createHash('sha256').update(id+identity).digest('hex');
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const r=await fetch(backend+req.url,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:Buffer.concat(chunks)});res.writeHead(r.status,Object.fromEntries([...r.headers].filter(([k])=>!['transfer-encoding','content-encoding','content-length'].includes(k))));res.end(Buffer.from(await r.arrayBuffer()));
  }catch(error){res.writeHead(500);res.end(String(error));}});
  let browser;try{await new Promise(r=>server.listen(0,'127.0.0.1',r));browser=await launchTestBrowser();const base=`http://127.0.0.1:${server.address().port}`;const evaluate=async(fn,...args)=>{const expression=typeof fn==='function'?`(${fn.toString()})(...${JSON.stringify(args)})`:fn;const r=await browser.page.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});if(r.exceptionDetails)throw Error(JSON.stringify(r.exceptionDetails));return r.result.value;};
    await task({browser,base,ev:evaluate,navigate:async name=>browser.page.call('Page.navigate',{url:base+'/?case='+encodeURIComponent(name)})});
  }finally{if(browser)await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
}
async function testSaveTransport(){
  const results=[];const assert=(ok,label)=>{if(!ok)throw Error(label);};
  function page(){return `<!doctype html><html lang="en"><meta charset="utf-8"><title>Real save transport tests</title><link rel="stylesheet" href="save-system.css"><script>
  window.__nativeFetch=fetch.bind(window);window.__calls=[];window.__fault={};const timeout=setTimeout;window.setTimeout=(fn,ms,...a)=>timeout(fn,ms===15000?250:ms,...a);const interval=setInterval;window.setInterval=(fn,ms,...a)=>interval(fn,ms===3000?100:ms,...a);
  window.fetch=async(input,options={})=>{const path=String(input),method=options.method||'GET';window.__calls.push({path,method,body:options.body,hash:new Headers(options.headers).get('x-amz-content-sha256')});const f=window.__fault;if(f.mode&&path.includes(f.path||'/api/autosave')&&method===(f.method||'POST')&&(f.remaining??1)>0){f.remaining=(f.remaining??1)-1;if(f.mode==='offline')throw TypeError('TEST offline');if(f.mode==='server')return new Response(JSON.stringify({error:'TEST unavailable'}),{status:503,headers:{'Content-Type':'application/json'}});if(f.mode==='timeout')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('TEST timed out','AbortError')),{once:true}));if(f.mode==='hold')return new Promise((resolve,reject)=>window.__release=()=>window.__nativeFetch(input,options).then(resolve,reject));if(f.mode==='lost'){await window.__nativeFetch(input,options);throw TypeError('TEST response lost');}if(f.mode==='corrupt'){const r=await window.__nativeFetch(input,options),saved=await r.json();saved.state.schemaVersion=1;return new Response(JSON.stringify(saved),{headers:{'Content-Type':'application/json'}});}}return window.__nativeFetch(input,options);};
  </script><script src="save-system.js"></script><script>
  window.__state={party:[{name:'Niko Himura',hp:100,maxHP:100,en:100,maxEN:100,alive:true,_turnStarted:true,guarding:false,status:{}}],enemies:[{name:'Soulless Survivor',hp:40000,en:2100,status:{}}],flags:{phase:'player',_inPlayerPhase:true,currentActorIdx:0,_actedThisPhase:[false]}};window.__ready=true;
  RpgSaves.install({hasBattle:()=>true,isReady:()=>window.__ready,animationsDone:()=>Promise.resolve(),combat:()=>window.__state,inventory:()=>[{item_id:'noodles',quantity:3}],snapshot:()=>window.__state,currentEnemy:()=>null,currentActor:()=> 'Niko Himura',restore:saved=>{if(saved.state.schemaVersion!==2)throw Error('Incompatible schema');window.__state=saved.state;}});
  </script></html>`;}
  await withIntegrationBrowser('transport',page,async({ev,navigate})=>{
    async function poll(fn,label,ms=5000){const end=Date.now()+ms;while(Date.now()<end){if(await ev(fn))return;await waitFor(20);}throw Error('Timed out: '+label);}
    async function test(name,fn){await navigate(name);try{const evidence=await fn();results.push({group:'Real save UI and transport failures',name,passed:true,evidence,calls:await ev(()=>window.__calls)});}catch(error){results.push({group:'Real save UI and transport failures',name,passed:false,error:String(error),evidence:await ev(()=>({status:document.querySelector('.rpg-save-dialog [role=status]')?.textContent,controls:document.querySelector('#rpg-save-controls')?.textContent,calls:window.__calls}))});}}
    const slots=()=>document.querySelectorAll('.rpg-save-slot').length===6;
    async function fresh({fault=null}={}){await ev(()=>RpgSaves.openPicker()&&undefined);await poll(slots,'opening picker');await ev(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='New Battle').click());if(fault)await ev(f=>window.__fault=f,fault);await ev(()=>{if(!RpgSaves.begin())throw Error('Begin blocked');RpgSaves.openingFinished();});await poll(()=>!document.querySelector('[data-save]').disabled,'ready turn');}
    async function selectSave(){await ev(()=>document.querySelector('[data-save]').click());await poll(slots,'manual slots');await ev(()=>document.querySelector('[data-slot="1"]').click());}
    async function cancelRetry(){await ev(()=>{window.__fault={};[...document.querySelectorAll('button')].find(b=>b.textContent==='Cancel').click();});await selectSave();await poll(()=>!document.querySelector('.rpg-save-dialog'),'retry confirmation');}
    await test('Opening picker recovers from server error',async()=>{await ev(()=>{window.__fault={mode:'server',path:'/api/saves',method:'GET'};RpgSaves.openPicker();});await poll(()=>document.querySelector('.rpg-save-dialog [role=status]')?.textContent.includes('unavailable'),'visible error');await ev(()=>{window.__fault={};[...document.querySelectorAll('button')].find(b=>b.textContent==='Refresh saves').click();});await poll(slots,'refreshed slots');});
    for(const mode of ['offline','server','timeout'])await test('Manual save '+mode+' keeps failure visible and can retry',async()=>{await fresh();await poll(async()=>!!(await (await fetch('/api/saves/6')).json()),'autosave committed');await ev(mode=>window.__fault={mode,path:'/api/saves/1',method:'PUT'},mode);await selectSave();await poll(()=>document.querySelector('.rpg-save-dialog [role=status]')?.textContent.startsWith('Save failed:'),'save failure');assert(await ev(async()=>await (await fetch('/api/saves/1')).json())===null,'Failed save is not marked committed');await cancelRetry();assert((await ev(async()=>await (await fetch('/api/saves/1')).json())).state.party[0].hp===100,'Successful retry preserves state');});
    await test('Lost autosave response retries idempotently using captured opening state',async()=>{await fresh({fault:{mode:'lost',remaining:1}});await ev(()=>window.__state.party[0].hp=40);await poll(()=>window.__calls.filter(c=>c.path==='/api/autosave').length>=2,'autosave retry');const state=await ev(async()=>await (await fetch('/api/saves/6')).json());assert(state.state.party[0].hp===100,'Retry must use original opening boundary');const history=await ev(async()=>await (await fetch('/api/history')).json());assert(history.length===1,'Retry must not create a second battle');});
    await test('Pending history recovers after network loss without duplicate decisions',async()=>{await fresh();await poll(async()=>!!(await (await fetch('/api/saves/6')).json()),'autosave committed');await ev(()=>{window.__fault={mode:'offline',path:'/api/battles/events',method:'POST',remaining:2};RpgSaves.intent('attack',null,['Soulless Survivor']);window.__state.enemies[0].hp-=10;RpgSaves.player('Niko Himura','attack',null);RpgSaves.ready();});await poll(async()=>{const h=await (await fetch('/api/history')).json();return h[0]?.decisions.length===1;},'history retry');const h=await ev(async()=>await (await fetch('/api/history')).json());assert(h[0].decisions[0].sequence_number===1,'One history sequence');});
    await test('Pending autosave blocks starting another battle',async()=>{await fresh({fault:{mode:'hold'}});assert(await ev(()=>RpgSaves.begin())===false,'Cannot discard pending opening');await ev(()=>window.__release());await poll(()=>document.querySelector('#rpg-save-controls [role=status]').textContent.includes('saved'),'opening committed');assert(await ev(()=>RpgSaves.begin())===true,'New battle allowed after commit');});
    await test('Double save clicks and Escape during pending write cannot duplicate a save',async()=>{await fresh();await poll(async()=>!!(await (await fetch('/api/saves/6')).json()),'opening committed');await ev(()=>window.__fault={mode:'hold',path:'/api/saves/1',method:'PUT'});await selectSave();await ev(()=>{const b=document.querySelector('[data-slot="1"]');b.click();b.click();document.querySelector('.rpg-save-dialog').dispatchEvent(new Event('cancel',{cancelable:true}));window.__state.party[0].hp=20;window.__release();});await poll(()=>!document.querySelector('.rpg-save-dialog'),'write confirmed');assert(await ev(()=>window.__calls.filter(c=>c.path==='/api/saves/1'&&c.method==='PUT').length)===1,'Only one PUT');const saved=await ev(async()=>await (await fetch('/api/saves/1')).json());assert(saved.state.party[0].hp===100,'Save captures click-time boundary');});
    await test('Refresh before a held write does not invent a successful manual save',async()=>{await fresh();await poll(async()=>!!(await (await fetch('/api/saves/6')).json()),'opening committed');await ev(()=>window.__fault={mode:'hold',path:'/api/saves/1',method:'PUT'});await selectSave();await navigate('Refresh before a held write does not invent a successful manual save');const saved=await ev(async()=>await (await fetch('/api/saves/1')).json());assert(saved===null,'Unsent write remains absent after refresh');});
    await test('Corrupted load keeps opening picker usable',async()=>{const payload=await ev(()=>({battleId:'corrupt-load',decisions:[],state:{...window.__state,schemaVersion:2,battleId:'corrupt-load',sequence:0,turn:1},inventory:[{item_id:'noodles',quantity:3}]}));await ev(async p=>{await fetch('/api/saves/1',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});window.__fault={mode:'corrupt',path:'/api/saves/1',method:'GET'};RpgSaves.openPicker();},payload);await poll(slots,'load picker');await ev(()=>document.querySelector('[data-slot="1"]').click());await poll(()=>document.querySelector('.rpg-save-dialog [role=status]')?.textContent.startsWith('Load failed:'),'incompatible load reported');assert(await ev(()=>![...document.querySelectorAll('button')].find(b=>b.textContent==='New Battle').disabled),'New Battle remains available');});
    await test('Large autosave lost commit response retries the same operation without advancing state',async()=>{
      await ev(()=>RpgSaves.openPicker()&&undefined);await poll(slots,'opening picker');await ev(()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='New Battle').click());
      await ev(()=>{window.__state.large='🧪'.repeat(90000);window.__fault={mode:'lost',path:'/commit',method:'POST'};RpgSaves.begin();RpgSaves.openingFinished();});
      await poll(()=>window.__calls.filter(c=>c.path.endsWith('/commit')).length>=1,'first commit',20000);await ev(()=>window.__state.party[0].hp=25);
      await poll(()=>window.__calls.filter(c=>c.path.endsWith('/commit')).length>=2,'commit retry',20000);
      await poll(()=>document.querySelector('#rpg-save-controls [role=status]').textContent.includes('saved'),'retry confirmed',20000);
      const evidence=await ev(()=>({commits:window.__calls.filter(c=>c.path.endsWith('/commit')).map(c=>c.path)}));assert(new Set(evidence.commits).size===1,'Retry uses exactly one operation receipt');return evidence;
    });
    await test('Large Unicode saves use signed chunks and restore after refresh',async()=>{
      await fresh();await poll(async()=>!!(await (await fetch('/api/saves/6')).json()),'opening committed');
      await ev(()=>{window.__state.large='🧪漢字'.repeat(140000);});await selectSave();
      await poll(()=>!document.querySelector('.rpg-save-dialog'),'large save committed',20000);
      const evidence=await ev(async()=>{const writes=window.__calls.filter(c=>c.method==='POST'||c.method==='PUT');for(const c of writes){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(c.body));const hash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');if(hash!==c.hash)throw Error('Body hash mismatch: '+c.path);}return {parts:writes.filter(c=>c.path==='/api/uploads').length,hashesVerified:writes.length};});
      assert(evidence.parts>1,'Large save must use transport chunks');await navigate('Large Unicode saves use signed chunks and restore after refresh');await ev(()=>RpgSaves.openPicker()&&undefined);await poll(slots,'refresh load picker');await ev(()=>document.querySelector('[data-slot="1"]').click());await poll(()=>!document.querySelector('.rpg-save-dialog'),'large load restored',20000);
      assert(await ev(()=>window.__state.large==='🧪漢字'.repeat(140000)),'Exact Unicode snapshot restored');assert(await ev(()=>window.__calls.some(c=>c.path.startsWith('/api/responses/'))),'Large load fetched response chunks');return evidence;
    });
    await test('Save readiness recovers when turn controls unlock after the ready notification',async()=>{
      await fresh();await ev(()=>{window.__ready=false;RpgSaves.invalidate();RpgSaves.ready();});await waitFor(120);
      assert(await ev(()=>document.querySelector('[data-save]').disabled),'Saving waits for the settled boundary');
      await ev(()=>window.__ready=true);await poll(()=>!document.querySelector('[data-save]').disabled,'delayed control unlock becomes ready');
    });
    await test('Save readiness waits for animation completion and invalidates stale callbacks',async()=>{await fresh();await ev(()=>{window.__ready=false;RpgSaves.invalidate();RpgSaves.ready();RpgSaves.enemyPhaseStart();window.__ready=true;});await waitFor(40);assert(await ev(()=>document.querySelector('[data-save]').disabled),'Enemy phase invalidates queued readiness');await ev(()=>RpgSaves.enemyPhaseEnd());await poll(()=>!document.querySelector('[data-save]').disabled,'next prepared turn');});
  });
  await emitExpandedReport('transport',{results,scope:'Actual save-system.js UI and real HTTP/PostgreSQL, with deterministic injected network errors, timeouts, response loss and delayed writes. Timeout/retry waits are shortened in the test page only.'});
}

async function testJourneysAndUi(){
  const results=[],out=process.env.RPG_EXPANDED_REPORT_DIR;const assert=(ok,label)=>{if(!ok)throw Error(label);};
  function bridge(){
    const saveTrace=[];
    for(const key of ['begin','ready','invalidate','intent','enemyPhaseStart','enemyPhaseEnd','openingFinished','leaveBattle','ending']){
      const original=window.RpgSaves[key];if(!original)continue;
      window.RpgSaves[key]=function(...args){const entry={method:key,time:performance.now(),phase,playerPhase:_inPlayerPhase};saveTrace.push(entry);if(saveTrace.length>50)saveTrace.shift();const result=original.apply(this,args);entry.result=result;return result;};
    }

    const nativeTimeout=setTimeout.bind(window);window.setTimeout=(fn,ms,...args)=>nativeTimeout(fn,[850,2450,450].includes(ms)?5:ms,...args);const nativeInterval=setInterval.bind(window);window.setInterval=(fn,ms,...args)=>nativeInterval(fn,typeof fn==='function'&&String(fn).includes('debugHpEnergyRestoreEnabledV68')?1:ms,...args);
    sleep=()=>new Promise(r=>nativeTimeout(r,1));swapBattleBgm=()=>{};duckBGM=()=>{};playSfxKey=()=>{};queueHurtFlash=()=>{};
    const clone=v=>JSON.parse(JSON.stringify(v));let seed=129;Math.random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296;};
    const listenerIds=new WeakMap(),active=new Set();let next=0;for(const target of [window,document]){const add=target.addEventListener.bind(target),remove=target.removeEventListener.bind(target);const label=target===window?'window':'document';target.addEventListener=function(type,fn,options){if(typeof fn==='function'&&!listenerIds.has(fn))listenerIds.set(fn,++next);if(typeof fn==='function')active.add(label+type+listenerIds.get(fn)+!!(typeof options==='boolean'?options:options?.capture));return add(type,fn,options);};target.removeEventListener=function(type,fn,options){if(typeof fn==='function')active.delete(label+type+listenerIds.get(fn)+!!(typeof options==='boolean'?options:options?.capture));return remove(type,fn,options);};}
    window.__journey={read:()=>({phase,actor:party[currentActorIdx]?.name,dialogue:isBattleDialogueActive(),inFlight:_actionInFlight,party:clone(party),enemies:clone(enemies),inventory:clone(bag),acted:[..._actedThisPhase],hpPhase:_ssPhase2Triggered,postSummons:_postSummonsDialogueDone,follow:clone(followCtx),log:UI.log.textContent,readiness:{prefight:_inPrefightFlow,playerPhase:_inPlayerPhase,guarding:party[currentActorIdx]?.guarding,selectedAction,pendingSkill:!!pendingSkill,follow:!!followCtx,turnStarted:party[currentActorIdx]?._turnStarted,submenu:UI.subMenu.textContent,saveDisabled:document.querySelector('[data-save]')?.disabled,status:document.querySelector('#rpg-save-controls [role=status]')?.textContent,saveTrace:clone(saveTrace),saveState:window.__saveReadinessProbe?.()},commands:[...UI.menu.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled})),listeners:active.size,nodes:document.querySelectorAll('*').length,keyboard:{focused:document.activeElement?.outerHTML?.slice(0,220),beforeConnected:window.__focusBefore?.isConnected,expectedConnected:window.__focusExpected?.isConnected,events:window.__keyboardTrace}}),
      enter:()=>window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',code:'Enter',bubbles:true})),
      combo:(middle,last)=>{for(const [key,code]of [['Alt','AltLeft'],[middle,'Key'+middle.toUpperCase()],[last,'Key'+last.toUpperCase()]])document.dispatchEvent(new KeyboardEvent('keydown',{key,code,altKey:true,bubbles:true}));for(const [key,code]of [[last,'Key'+last.toUpperCase()],[middle,'Key'+middle.toUpperCase()],['Alt','AltLeft']])document.dispatchEvent(new KeyboardEvent('keyup',{key,code,altKey:false,bubbles:true}));},
      fixture:(names=['Niko Himura','Toshiro Yoshikawa','Miya Hagimoto','Hotaru Minami'])=>{resetBattleProgress();party=names.map(n=>buildStatsFromTiers(n,normalizeTiers(ROSTER[n])));party.forEach(p=>{p.hp=p.maxHP=10000;p.en=p.maxEN=10000;p._turnStarted=true;p.surpriseReady=false;});enemies=[makeEnemy('Soulless Survivor',40000,445,225,0,2100,'high'),makeEnemy('Training Target',20000,100,100,0,1000,'high')];bag=defaultBag();phase='player';_inPlayerPhase=true;_actedThisPhase=party.map(()=>false);currentActorIdx=0;selectedAction=null;pendingSkill=null;followCtx=null;_pickCtx=null;_actionInFlight=false;_battleDialogueLockDepth=0;inSpecialDialogue=false;_inPrefightFlow=false;UI.overlay.style.display='none';UI.selectPanel.style.display='none';UI.battleUI.style.display='';renderBars();renderCommandMenu();},
      openFollow:(step='partner')=>{followCtx={initiatorIdx:0,partnerIdx:1,step};if(step==='partner')renderFollowPartnerMenu();else if(step==='choice')renderFollowChoiceMenu();else renderFollowAttackTarget();},
      sandboxHealth:()=>party.forEach(p=>{p.hp=p.maxHP=1000000;}),
      armAnimation:()=>{_actionInFlight=true;},releaseAnimation:()=>{_actionInFlight=false;},
      renderMany:()=>{enemies=Array.from({length:250},(_,i)=>makeEnemy('Test Subject '+i,1600,100,10,0,1000,'high'));const start=performance.now();renderBars();return {ms:performance.now()-start,rows:document.querySelectorAll('#enemyList .row').length};}
    };
  }
  function documentFactory(original){const anchor='\n})();\n\n// === global error fallbacks ===';return original.replace(anchor,`\nwindow.addEventListener('DOMContentLoaded',()=>(${bridge.toString()})(),{once:true});\n${anchor}`);}
  await withIntegrationBrowser('journeys',documentFactory,async({browser,ev,navigate})=>{
    let id=0;async function poll(fn,label,ms=6000){const end=Date.now()+ms;while(Date.now()<end){if(await ev(fn))return;await waitFor(15);}throw Error('Timed out: '+label);}
    async function capture(name){const {writeFile}=await import('node:fs/promises');const image=await browser.page.call('Page.captureScreenshot',{format:'png'});await writeFile(absolutePath(out,name+'.png'),Buffer.from(image.data,'base64'));return name+'.png';}
    async function open(){await navigate('ui-'+(++id));await ev(()=>document.getElementById('introYesBtnV56').click());await poll(()=>document.querySelectorAll('.rpg-save-slot').length===6,'opening save picker');await ev(()=>[...document.querySelectorAll('.rpg-save-dialog button')].find(b=>b.textContent==='New Battle').click());}
    async function test(group,name,fn,{fixture=true}={}){await open();if(fixture)await ev(()=>window.__journey.fixture());try{const evidence=await fn();results.push({group,name,passed:!evidence?.skipped,skipped:!!evidence?.skipped,reason:evidence?.reason,evidence});console.log(`${evidence?.skipped?'SKIP':'PASS'} ${group} / ${name}`);}catch(error){console.log(`FAIL ${group} / ${name}: ${error}`);const shot=await capture('failure-'+id);results.push({group,name,passed:false,error:String(error),evidence:await ev(()=>window.__journey.read()),screenshot:shot});}}
    async function clickText(selector,text){await ev((selector,text)=>{const b=[...document.querySelectorAll(selector)].find(b=>b.textContent.trim()===text&&!b.disabled);if(!b)throw Error('Enabled control missing: '+text);b.click();},selector,text);await waitFor(20);}
    async function start(names=['Toshiro Yoshikawa','Miya Hagimoto','Hotaru Minami']){await ev(names=>{for(const name of names){const card=[...document.querySelectorAll('#candidateGrid > .card')].find(c=>c.textContent.includes(name));if(!card)throw Error('Card missing '+name);if(!card.classList.contains('selected'))card.click();}document.getElementById('startBtn').click();},names);await dialogueToReady();}
    async function resolveFollow(){await ev(()=>{const buttons=[...document.querySelectorAll('#subMenu button')].filter(b=>!b.disabled);const choice=buttons.find(b=>b.textContent.includes('Defensive option:'))||buttons.find(b=>/^Choose /.test(b.textContent.trim()));if(!choice)throw Error('Follow-up policy has no available choice');choice.click();});await waitFor(10);}
    async function dialogueToReady(){const deadline=Date.now()+10000;while(Date.now()<deadline){const state=await ev(()=>window.__journey.read());if(!state.dialogue&&!state.inFlight&&state.commands.some(c=>c.text==='Attack'&&!c.disabled)&&await ev(()=>!document.querySelector('[data-save]').disabled))return;await ev(()=>window.__journey.enter());await waitFor(5);}throw Error('Opening/transition did not become ready');}
    await test('UI controls','Attack cancellation preserves turn and all resources',async()=>{const before=await ev(()=>window.__journey.read());await clickText('#menu button','Attack');assert(await ev(()=>document.querySelectorAll('#subMenu button').length>0),'Target chooser shown');const back=await ev(()=>{const b=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.trim()==='Back');b?.click();return !!b;});assert(back,'Back from targeting exists');const after=await ev(()=>window.__journey.read());assert(JSON.stringify(before.party)===JSON.stringify(after.party),'Cancel preserves party');assert(JSON.stringify(before.inventory)===JSON.stringify(after.inventory),'Cancel preserves inventory');assert(after.acted.every(v=>!v),'Cancel consumes no turn');});
    await test('Rapid input','Double Confirm Guard consumes at most one actor turn',async()=>{await clickText('#menu button','Guard');await ev(()=>{const b=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.includes('Confirm Guard'));b.click();b.click();});const state=await ev(()=>window.__journey.read());assert(state.acted.filter(Boolean).length===1,'Double-click cannot consume two actors');});
    await test('Rapid input','Commands blocked during an animation lock',async()=>{await ev(()=>window.__journey.armAnimation());await ev(()=>[...document.querySelectorAll('#menu button')].find(b=>b.textContent==='Attack').click());assert(await ev(()=>document.getElementById('subMenu').textContent.trim()===''),'Animation lock does not open target menu');await ev(()=>window.__journey.releaseAnimation());});
    await test('Keyboard handlers','Escape cancels a target menu without an action',async()=>{await clickText('#menu button','Attack');await ev(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',code:'Escape',bubbles:true})));await waitFor(30);const s=await ev(()=>window.__journey.read());assert(s.acted.every(v=>!v),'Escape costs no turn');assert(s.commands.some(c=>c.text==='Attack'&&!c.disabled),'Commands restored');});
    await test('Keyboard handlers','Held Enter does not skip out of battle or consume a player action',async()=>{await ev(()=>{for(let i=0;i<50;i++)window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',repeat:true,bubbles:true}));});assert((await ev(()=>window.__journey.read())).acted.every(v=>!v),'Unbound Enter cannot act');});
    for(const step of ['partner','choice','target'])await test('Follow-up UI navigation','Back from '+step,async()=>{await ev(step=>window.__journey.openFollow(step),step);assert(await ev(()=>document.getElementById('subMenu').querySelectorAll('button').length>0),'Follow-up controls rendered');await ev(()=>{const proxy=document.getElementById('finalBackButtonProxy');const local=[...document.querySelectorAll('#subMenu button')].find(b=>/^Back$/.test(b.textContent.trim()));const button=proxy&&!proxy.hidden?proxy:local;if(!button)throw Error('Follow-up Back unavailable');button.click();});await waitFor(30);const state=await ev(()=>window.__journey.read());assert(state.phase==='player'&&!state.inFlight,'Follow-up Back does not freeze combat');});
    await test('UI menus','Every item is present across paginated menus',async()=>{await clickText('#menu button','Items');const seen=await ev(()=>[...document.querySelectorAll('#subMenu button')].map(b=>b.textContent).join('\n'));const bag=await ev(()=>window.__journey.read().inventory);for(const item of bag)assert(seen.includes(item.name),'Item omitted from menu DOM: '+item.name);const pages=await ev(()=>[...document.querySelectorAll('#subMenu button')].filter(b=>/^(Next|Previous)$/.test(b.textContent.trim())).length);return {items:bag.length,pagingControls:pages};});
    await test('UI menus','Detailed/Simple toggle retains current actor and turn',async()=>{const before=await ev(()=>window.__journey.read());const toggled=await ev(()=>{const b=document.getElementById('skillViewToggleBtn')||[...document.querySelectorAll('button')].find(b=>/Detailed View|Simple View/.test(b.textContent));if(!b)return false;b.click();b.click();return true;});assert(toggled,'View toggle exists');const after=await ev(()=>window.__journey.read());assert(after.actor===before.actor&&after.acted.every(v=>!v),'View changes never spend a turn');});
    await test('UI menus','Guide opens and closes without changing battle state',async()=>{const before=await ev(()=>window.__journey.read());await ev(()=>document.getElementById('battleGuideBtn').click());await waitFor(50);assert(await ev(()=>{const drawer=document.getElementById('guideDrawer');return drawer&&getComputedStyle(drawer).display!=='none';}),'Guide visible');await ev(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));const after=await ev(()=>window.__journey.read());assert(after.actor===before.actor&&JSON.stringify(after.party)===JSON.stringify(before.party),'Guide does not modify combat');});
    for(const viewport of [{width:390,height:844},{width:768,height:1024},{width:1440,height:900}])await test('Responsive game layout',viewport.width+'×'+viewport.height,async()=>{await browser.page.call('Emulation.setDeviceMetricsOverride',{...viewport,deviceScaleFactor:1,mobile:viewport.width<500});await waitFor(80);const b=await ev(()=>{const stage=document.getElementById('battleUI'),r=stage.getBoundingClientRect();const controls=[...document.querySelectorAll('#menu button')].filter(b=>!b.disabled).map(b=>({name:b.textContent,r:{x:b.getBoundingClientRect().x,y:b.getBoundingClientRect().y,width:b.getBoundingClientRect().width,height:b.getBoundingClientRect().height}}));return {width:innerWidth,height:innerHeight,battle:{x:r.x,y:r.y,width:r.width,height:r.height},controls,scrollWidth:document.documentElement.scrollWidth};});const image=await capture('viewport-'+viewport.width);assert(b.controls.length>=4,'Main commands present');assert(b.controls.every(c=>c.r.width>0&&c.r.height>0&&c.r.x>=0&&c.r.x+c.r.width<=b.width+2),'Commands must fit reachable viewport');return {...b,screenshot:image};});
    await browser.page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await test('Accessibility: structural checks','Visible buttons have accessible names',async()=>{const missing=await ev(()=>[...document.querySelectorAll('button')].filter(b=>{const r=b.getBoundingClientRect();return r.width&&r.height&&getComputedStyle(b).visibility!=='hidden';}).filter(b=>!((b.getAttribute('aria-label')||b.textContent||b.title).trim())).map(b=>b.outerHTML));assert(!missing.length,'Unnamed visible buttons: '+JSON.stringify(missing));});
    await test('Accessibility: structural checks','IDs remain unique after interface initializes',async()=>{const duplicate=await ev(()=>{const seen=new Set(),out=[];for(const e of document.querySelectorAll('[id]')){if(seen.has(e.id))out.push(e.id);seen.add(e.id);}return out;});assert(!duplicate.length,'Duplicate IDs break labels/focus: '+duplicate.join(', '));});
    await test('Accessibility: native keyboard','Command layout preserves focus when correcting button order',async()=>{
      await browser.page.call('Page.bringToFront');
      await ev(()=>{const menu=document.getElementById('menu');const attack=[...menu.children].find(b=>b.textContent.trim()==='Attack');menu.appendChild(attack);attack.focus();window.__layoutFocus=attack;});
      await poll(()=>document.querySelector('#menu button')===window.__layoutFocus,'command order corrected');
      await ev(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      assert(await ev(()=>document.activeElement===window.__layoutFocus&&window.__layoutFocus.isConnected),'Layout updates preserve the focused command');
      assert(await ev(()=>window.__journey.read().acted.every(v=>!v)),'Layout correction never consumes a turn');
    });
    await test('Accessibility: native keyboard','Tab moves browser focus to a control',async()=>{
      await browser.page.call('Page.bringToFront');
      // Exercise two adjacent game controls. Tabbing from the last page control
      // can legitimately enter browser chrome instead of another DOM element.
      await poll(()=>{const commands=[...document.querySelectorAll('#menu button')];return commands.length>=2&&commands.slice(0,2).every(b=>!b.disabled&&b.getBoundingClientRect().width>0);},'keyboard controls are ready');
      await ev(()=>{
        window.__keyboardTrace=[];
        for(const type of ['keydown','keyup','focusin','focusout'])document.addEventListener(type,event=>{
          const entry={type,key:event.key,code:event.code,trusted:event.isTrusted,target:event.target?.textContent?.slice(0,35)};
          setTimeout(()=>{entry.prevented=event.defaultPrevented;entry.focus=document.activeElement?.outerHTML?.slice(0,160);window.__keyboardTrace.push(entry);},0);
        },true);
        const commands=[...document.querySelectorAll('#menu button')];window.__focusBefore=commands[0];window.__focusExpected=commands[1];commands[0].focus();
      });
      await poll(()=>document.hasFocus()&&document.activeElement===window.__focusBefore,'first command receives focus');
      await browser.page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab'});
      await browser.page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab'});
      await poll(()=>document.activeElement===window.__focusExpected,'native Tab advances to the next command');
      await ev(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
      assert(await ev(()=>document.activeElement===window.__focusExpected),'Keyboard focus remains on the next command after layout updates');
      return {from:'Attack',to:'Guard',nativeKeyboard:true};
    });
    await test('Touch input','Touching Guard opens its confirmation',async()=>{await browser.page.call('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});const point=await ev(()=>{const b=[...document.querySelectorAll('#menu button')].find(b=>b.textContent==='Guard');b.scrollIntoView();const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};});await browser.page.call('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[point]});await browser.page.call('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await poll(()=>[...document.querySelectorAll('#subMenu button')].some(b=>b.textContent.includes('Confirm Guard')),'Touch Guard confirmation');});
    await browser.page.call('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    await test('High-DPI layout','Two device pixel ratios retain usable command controls',async()=>{const observations=[];for(const ratio of [1,2]){await browser.page.call('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:ratio,mobile:false});await waitFor(30);const b=await ev(()=>[...document.querySelectorAll('#menu button')].map(b=>({text:b.textContent,w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height})));assert(b.every(b=>b.w>0&&b.h>0),'Commands visible at ratio '+ratio);observations.push({ratio,controls:b});}return observations;});
    await test('Browser zoom','Native browser zoom keeps command controls reachable',async()=>{const observations=[];const initialZoom=await ev(()=>({ratio:devicePixelRatio,width:innerWidth}));for(let n=0;n<2;n++){await browser.page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',modifiers:2});await browser.page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'+' ,modifiers:2});await browser.page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'+',modifiers:2});await browser.page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Control'});await waitFor(50);const data=await ev(()=>({ratio:devicePixelRatio,width:innerWidth,controls:[...document.querySelectorAll('#menu button')].map(b=>{const r=b.getBoundingClientRect();return {text:b.textContent,width:r.width,height:r.height,x:r.x};})}));assert(data.controls.every(c=>c.width>0&&c.height>0&&c.x>=0&&c.x+c.width<=data.width+2),'Zoom clips commands');observations.push(data);}await browser.page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'Control',modifiers:2});await browser.page.call('Input.dispatchKeyEvent',{type:'keyDown',key:'0',modifiers:2});await browser.page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'0',modifiers:2});await browser.page.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Control'});if(!observations.some(v=>v.ratio!==initialZoom.ratio||v.width!==initialZoom.width)){return {skipped:true,reason:'The browser automation driver did not apply native browser-chrome zoom shortcuts. CSS zoom and high-DPI layouts are checked separately.',observations};}return observations;});
    await test('Browser zoom','CSS page zoom at 125% and 150% preserves commands',async()=>{const data=[];try{for(const zoom of [1.25,1.5]){await ev(zoom=>{document.documentElement.style.zoom=String(zoom);window.dispatchEvent(new Event('resize'));},zoom);await waitFor(30);const controls=await ev(()=>[...document.querySelectorAll('#menu button')].map(b=>{const r=b.getBoundingClientRect();return {width:r.width,height:r.height};}));assert(controls.length>=4&&controls.every(c=>c.width>0&&c.height>0),'Commands remain visible under CSS zoom');data.push({zoom,controls});}}finally{await ev(()=>{document.documentElement.style.zoom='';window.dispatchEvent(new Event('resize'));});}return data;});
    await test('UI guide pages','Rules and character tabs expose every current character',async()=>{await ev(()=>document.getElementById('battleGuideBtn').click());for(const tab of ['rules','characters']){await ev(tab=>document.querySelector('[data-guide-tab="'+tab+'"]').click(),tab);const state=await ev(tab=>{const page=document.querySelector('[data-guide-page="'+tab+'"]');return {active:page.classList.contains('is-active'),text:page.textContent};},tab);assert(state.active,'Guide tab becomes active: '+tab);if(tab==='characters')for(const name of ['Niko Himura','Toshiro Yoshikawa','Towa Himura','Miya Hagimoto','Hotaru Minami','Akio Mamoru'])assert(state.text.includes(name),'Guide missing '+name);}await ev(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));});
    await test('UI Mimic navigation','Every source opens, paginates and returns without spending resources',async()=>{await ev(()=>window.__journey.fixture(['Akio Mamoru','Niko Himura','Toshiro Yoshikawa','Hotaru Minami']));const before=await ev(()=>window.__journey.read());await clickText('#menu button','Skills');await ev(()=>{const button=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.includes('Mimic')&&!b.disabled);if(!button)throw Error('Mimic skill missing');button.click();});await waitFor(30);const sources=await ev(()=>[...document.querySelectorAll('#subMenu button')].filter(b=>b.textContent.includes('Copy from')).map(b=>b.textContent.trim()));assert(sources.length>=5,'All Mimic sources listed');for(const source of sources){await ev(source=>{const b=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.trim()===source);b.click();},source);await waitFor(15);assert(await ev(()=>document.querySelectorAll('#subMenu button').length>1),'Copied skill menu populated');for(let n=0;n<10;n++){const moved=await ev(()=>{const b=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.trim()==='Next'&&!b.disabled);if(!b)return false;b.click();return true;});if(!moved)break;await waitFor(5);}await ev(()=>{const b=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.trim()==='Back');if(!b)throw Error('Mimic Back missing');b.click();});await waitFor(15);}const after=await ev(()=>window.__journey.read());assert(JSON.stringify(before.party)===JSON.stringify(after.party),'Browsing Mimic never costs HP/EN');assert(after.acted.every(v=>!v),'Browsing Mimic never spends a turn');return {sources};});
    await test('Performance: crowded battle','250 enemy rows render within a coarse responsiveness budget',async()=>{const data=await ev(()=>window.__journey.renderMany());assert(data.rows===250,'All enemies rendered');assert(data.ms<3000,'Rendering freezes for more than 3 seconds');return data;});
    await test('Long session: repeated starts','Six battles do not accumulate duplicate UI or dialogue listeners',async()=>{const samples=[];for(let n=0;n<6;n++){await ev(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Shift',code:'ShiftLeft',bubbles:true})));await waitFor(70);await start();const s=await ev(()=>window.__journey.read());samples.push({listeners:s.listeners,nodes:s.nodes});assert(await ev(()=>document.querySelectorAll('#rpg-save-controls').length)===1,'One save control bar');assert(s.party.length===4,'Exactly four party members');assert(await ev(()=>getComputedStyle(document.getElementById('battleUI')).display!=='none'&&getComputedStyle(document.getElementById('selectPanel')).display==='none'),'Delayed reset callbacks cannot replace the new battle with party selection');}assert(samples.at(-1).listeners<=samples[1].listeners+3,'Repeated starts leak dialogue listeners');assert(samples.at(-1).nodes<=samples[1].nodes+50,'Repeated starts accumulate DOM nodes');return samples;});
    await test('Full battle: natural defeat','Unmodified stats reach game over through ordinary Guard controls',async()=>{await start();let actions=0;const deadline=Date.now()+45000;while(Date.now()<deadline){const s=await ev(()=>window.__journey.read());if(s.phase==='end'){await ev(()=>window.__journey.enter());await waitFor(5);if(await ev(()=>!!document.getElementById('nikoGameOverScreenV57')))return {actions,phase:s.phase,seed:129};continue;}if(s.dialogue){await ev(()=>window.__journey.enter());continue;}if(s.follow){await resolveFollow();continue;}if(s.phase==='player'&&s.commands.some(c=>c.text==='Guard'&&!c.disabled)){await clickText('#menu button','Guard');await clickText('#subMenu button','Confirm Guard');actions++;}else await waitFor(5);}throw Error('Normal-stat Guard playthrough did not reach game over in 45 seconds');},{fixture:false});
    await test('Full battle: all stages','High-HP sandbox victory uses ordinary controls through every dialogue and credits',async()=>{await start();await ev(()=>{window.__journey.sandboxHealth();window.__journey.combo('a','l');});let actions=0;const deadline=Date.now()+60000;let seenPost=false,seenHp=false;while(Date.now()<deadline){const s=await ev(()=>window.__journey.read());seenPost||=s.postSummons;seenHp||=s.hpPhase;if(s.phase==='end')throw Error('Accelerated sandbox reached defeat before victory');if(s.phase==='ending'){assert(seenPost&&seenHp,'Playthrough crosses post-summons and HP stages');await poll(()=>!!document.getElementById('simulationCreditsV96'),'credits appear',5000);return {actions,seed:129,seenPost,seenHp,controls:'Real Attack/Item buttons and real dialogues; built-in ATK shortcut and enlarged test-fixture HP make this a deterministic progression sandbox, not a difficulty or survival test.'};}if(s.dialogue){await ev(()=>window.__journey.enter());await waitFor(3);continue;}if(s.follow){await resolveFollow();continue;}if(s.phase==='player'&&s.commands.some(c=>c.text==='Attack'&&!c.disabled)&&s.enemies.some(e=>e.name==='Soulless Survivor'&&e._analytical?.current==='REPEL_BASIC')){await clickText('#menu button','Items');await ev(()=>{const item=[...document.querySelectorAll('#subMenu button')].find(b=>b.textContent.includes('Myriad Truths')&&!b.disabled);if(!item)throw Error('Reflection-safe item depleted');item.click();});actions++;continue;}if(s.phase==='player'&&s.commands.some(c=>c.text==='Attack'&&!c.disabled)){await clickText('#menu button','Attack');await ev(()=>{const candidates=[...document.querySelectorAll('#subMenu button')].filter(b=>!b.disabled&&/HP/.test(b.textContent));const target=candidates.find(b=>b.textContent.includes('Itachi'))||candidates.find(b=>b.textContent.includes('Yuki'))||candidates.find(b=>b.textContent.includes('Soulless Survivor'))||candidates[0];if(!target)throw Error('No eligible attack target');target.click();});actions++;}else await waitFor(5);}throw Error('Accelerated victory path did not finish in 60 seconds');},{fixture:false});
    const baseline=process.env.RPG_VISUAL_BASELINE_DIR;
    if(!baseline)results.push({group:'Visual regression',name:'Approved screenshot comparison',passed:false,skipped:true,reason:baseline?'Provided baseline directory requires matching viewport references':'No approved game screenshot baseline supplied. Viewport screenshots are captured for review; screenshots are not approved automatically.'});
    if(baseline){const {readFile}=await import('node:fs/promises');for(const width of [390,768,1440]){try{const actual=await readFile(absolutePath(out,'viewport-'+width+'.png')),expected=await readFile(absolutePath(baseline,'viewport-'+width+'.png'));const comparison=await ev(async(a,b)=>{async function pixels(src){const i=new Image();i.src=src;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return {width:i.width,height:i.height,data:ctx.getImageData(0,0,i.width,i.height).data};}const x=await pixels(a),y=await pixels(b);if(x.width!==y.width||x.height!==y.height)return {sameSize:false};let changed=0;for(let i=0;i<x.data.length;i+=4)if(Math.max(...[0,1,2].map(k=>Math.abs(x.data[i+k]-y.data[i+k])))>12)changed++;return {sameSize:true,changedFraction:changed/(x.width*x.height)};},'data:image/png;base64,'+actual.toString('base64'),'data:image/png;base64,'+expected.toString('base64'));assert(comparison.sameSize&&comparison.changedFraction<=Number(process.env.RPG_VISUAL_DIFF_LIMIT||.01),'Viewport differs from approved baseline');results.push({group:'Visual regression',name:width+' approved viewport',passed:true,evidence:comparison});}catch(error){results.push({group:'Visual regression',name:width+' approved viewport',passed:false,error:String(error)});}}}
    for(const [name,reason]of [['Balance and difficulty','No approved win-rate, battle-length or damage-budget targets supplied. Seeded playthrough metrics are collected, but difficulty is not judged automatically.'],['Screen-reader usability','Structural labels and native focus are automated; actual screen-reader output and comprehensibility require assistive-technology review.'],['Art direction and physical audio','Browser image/audio decoding is tested by init. Artistic correctness, audible mix and real speaker output require human review.'],['Heap growth across browsers','Portable browser heap measurements are not exposed by the current driver; listener/DOM growth and calculation/render stress are checked instead.']])results.push({group:'Explicit manual review',name,passed:false,skipped:true,reason});
  });
  await emitExpandedReport('journeys',{results,scope:'Real game UI, real turn advancement and dialogue, same-origin API and temporary database. Enemy/intro cosmetic waits shortened; media output isolated here and tested unstubbed by init. Natural-stat defeat and high-HP/debug-ATK sandbox victory are distinct scenarios.'});
}
async function testBrowserMatrix(){
  const configured=process.env.RPG_TEST_BROWSER_MATRIX;const results=[];
  if(!configured)results.push({group:'Cross-browser coverage',name:'Additional browser engines',passed:false,skipped:true,reason:'Default-browser suites still run. Set RPG_TEST_BROWSER_MATRIX to an explicit JSON array of browser executable paths to authorize a browser comparison; no other installed browser is selected silently.'});
  else{let paths;try{paths=JSON.parse(configured);}catch{throw Error('RPG_TEST_BROWSER_MATRIX must be a JSON array');}if(!Array.isArray(paths)||!paths.length||!paths.every(p=>typeof p==='string'))throw Error('Invalid browser matrix');for(let i=0;i<paths.length;i++){const directory=absolutePath(process.env.RPG_EXPANDED_REPORT_DIR,'engine-'+i);await makeDirectory(directory,{recursive:true});const child=startOwned([TEST_FILE,'--worker','init'],{env:{...process.env,RPG_TEST_BROWSER:paths[i],RPG_INIT_REPORT_DIR:directory}});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output+=b;process.stdout.write(b);});const code=await new Promise((r,j)=>{child.once('error',j);child.once('close',r);});await releaseOwned(child);try{const report=JSON.parse(await readResult(absolutePath(directory,'initialization.json'),'utf8'));for(const c of report.checks)results.push({...c,group:paths[i]+' / '+c.group});}catch(error){results.push({group:'Cross-browser coverage',name:paths[i],passed:false,error:String(error),output,exitCode:code});}}}
  await emitExpandedReport('matrix',{results,scope:'Only explicitly configured additional browsers are opened. The system default remains the normal test target.'});
}

const workerIndex=process.argv.indexOf('--worker');
try {
  if(workerIndex!==-1){
    const suite=SUITES.find(s=>s.id===process.argv[workerIndex+1]);
    if(!suite)throw Error('Unknown test worker');
    await suite.run();
  } else await main();
} catch(error){console.error(error.stack||error);process.exitCode=1;}
