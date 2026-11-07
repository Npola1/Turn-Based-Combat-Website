/** Shared isolated browser launcher: Chromium/CDP or Firefox/WebDriver BiDi. */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { resolveTestBrowser } from './default-test-browser.mjs';

function decode(value) {
  if (!value) return undefined;
  if (value.type === 'undefined') return undefined;
  if (value.type === 'null') return null;
  if (value.type === 'array' || value.type === 'set') return (value.value || []).map(decode);
  if (value.type === 'object' || value.type === 'map') return Object.fromEntries((value.value || []).map(([key,item])=>[typeof key==='string'?key:decode(key),decode(item)]));
  if (value.type === 'number' && typeof value.value === 'string') return Number(value.value);
  return value.value;
}
export async function launchTestBrowser({ profile, muted = true, onEvent = () => {} } = {}) {
  const selected = await resolveTestBrowser();
  console.log(`Using ${selected.source}: ${selected.name}`);
  const ownedProfile = !profile;
  profile ||= await mkdtemp(resolve(tmpdir(),'rpg-browser-'));
  await mkdir(profile,{recursive:true});
  const firefox = selected.engine === 'firefox';
  if (firefox) await writeFile(resolve(profile,'user.js'), `user_pref("browser.shell.checkDefaultBrowser", false);\nuser_pref("browser.startup.page", 0);\n${muted?'user_pref("media.volume_scale", "0.0");\n':''}`);
  const args = firefox ? ['--headless','--no-remote','--profile',profile,'--remote-debugging-port','0','about:blank'] : ['--headless','--disable-gpu',...(muted?['--mute-audio']:[]),'--no-first-run','--no-default-browser-check','--remote-debugging-port=0',`--user-data-dir=${profile}`,'about:blank'];
  const child = spawn(selected.executable,args,{stdio:['ignore','ignore','pipe']});
  let socket, pending = new Map(), id = 0, context, closed = false;
  const raw = (method,params={})=>new Promise((done,failed)=>{
    const key=++id,timer=setTimeout(()=>{pending.delete(key);failed(Error(`Browser command timed out: ${method}`));},120000);
    pending.set(key,message=>{clearTimeout(timer);message.error?failed(Error(`${message.error}: ${message.message||''}`)):done(message.result);});
    socket.send(JSON.stringify({id:key,method,params}));
  });
  const close = async()=>{
    if(closed)return;closed=true;
    if(socket?.readyState===WebSocket.OPEN){try{await raw(firefox?'session.end':'Browser.close');}catch{}socket.close();}
    if(child.exitCode===null&&child.signalCode===null){child.kill();await Promise.race([new Promise(done=>child.once('exit',done)),new Promise(done=>setTimeout(done,3000))]);}
    if(ownedProfile)await rm(profile,{recursive:true,force:true,maxRetries:3,retryDelay:100}).catch(()=>{});
  };
  try {
    let endpoint = await new Promise((done,failed)=>{
      let output='';const timer=setTimeout(()=>failed(Error('Default browser automation did not start within 20 seconds')),20000);
      child.once('error',error=>{clearTimeout(timer);failed(error);});
      child.once('exit',code=>{clearTimeout(timer);failed(Error(`Default browser exited (${code}): ${output.slice(-1200)}`));});
      child.stderr.on('data',chunk=>{output=(output+chunk).slice(-8000);const match=output.match(firefox?/WebDriver BiDi listening on (ws:\/\/[^\s]+)/:/DevTools listening on (ws:\/\/[^\s]+)/);if(match){clearTimeout(timer);done(match[1]);}});
    });
    if(firefox)endpoint=endpoint.replace(/\/$/,'').replace(/\/session$/,'')+'/session';
    socket = new WebSocket(endpoint);
    await new Promise((done,failed)=>{socket.onopen=done;socket.onerror=failed;});
    socket.onmessage=event=>{
      const message=JSON.parse(event.data);
      if(message.id){pending.get(message.id)?.(message);pending.delete(message.id);return;}
      if(!firefox){onEvent(message.method,message.params);return;}
      const p=message.params;
      if(message.method==='log.entryAdded' && p.type==='javascript' && p.level==='error')onEvent('Runtime.exceptionThrown',{exceptionDetails:{text:p.text,exception:{description:p.text},stackTrace:p.stackTrace}});
      if(message.method==='network.responseCompleted')onEvent('Network.responseReceived',{requestId:p.request.request,response:{url:p.response.url,status:p.response.status,mimeType:p.response.mimeType}});
      if(message.method==='network.fetchError')onEvent('Network.loadingFailed',{requestId:p.request.request,errorText:p.errorText,canceled:/abort|cancel/i.test(p.errorText)});
    };
    socket.onclose=()=>{for(const fn of pending.values())fn({error:'Browser connection closed'});pending.clear();};
    if(firefox){
      await raw('session.new',{capabilities:{}});
      await raw('session.subscribe',{events:['log.entryAdded','network.responseCompleted','network.fetchError']});
      context=(await raw('browsingContext.create',{type:'tab'})).context;
    } else context=(await raw('Target.createTarget',{url:'about:blank'})).targetId;
    let pageSocket=socket;
    if(!firefox){
      const targets=await(await fetch(endpoint.replace(/^ws:/,'http:').replace(/\/devtools\/browser\/.*/,'/json'))).json();
      pageSocket=new WebSocket(targets.find(t=>t.id===context).webSocketDebuggerUrl);
      await new Promise((done,failed)=>{pageSocket.onopen=done;pageSocket.onerror=failed;});
      pageSocket.onmessage=event=>{const m=JSON.parse(event.data);if(m.id){pending.get(m.id)?.(m);pending.delete(m.id);}else onEvent(m.method,m.params);};
    }
    const cdpPage=(method,params={})=>new Promise((done,failed)=>{const key=++id,timer=setTimeout(()=>{pending.delete(key);failed(Error(`Browser command timed out: ${method}`));},120000);pending.set(key,m=>{clearTimeout(timer);m.error?failed(Error(m.error.message||m.error)):done(m.result);});pageSocket.send(JSON.stringify({id:key,method,params}));});
    const pageCall = async(method,p={})=>{
      if(!firefox)return cdpPage(method,p);
      switch(method){
        case 'Page.bringToFront':return raw('browsingContext.activate',{context});
        case 'Input.dispatchKeyEvent':{
          const keys={Tab:'\uE004',Enter:'\uE007',Escape:'\uE00C',Shift:'\uE008',Control:'\uE009',Alt:'\uE00A',ArrowLeft:'\uE012',ArrowUp:'\uE013',ArrowRight:'\uE014',ArrowDown:'\uE015'};
          return raw('input.performActions',{context,actions:[{type:'key',id:'rpg-keyboard',actions:[{type:p.type==='keyUp'?'keyUp':'keyDown',value:keys[p.key]||p.key}]}]});
        }
        case 'Input.dispatchTouchEvent':{
          const points=p.touchPoints||[];const actions=points.length?[{type:'pointerMove',x:Math.round(points[0].x),y:Math.round(points[0].y),duration:0},{type:'pointerDown',button:0}]:[{type:'pointerUp',button:0}];
          return raw('input.performActions',{context,actions:[{type:'pointer',id:'rpg-touch',parameters:{pointerType:'touch'},actions}]});
        }
        case 'Runtime.enable':case 'Page.enable':case 'Network.enable':return {};
        case 'Page.navigate':return raw('browsingContext.navigate',{context,url:p.url,wait:'complete'});
        case 'Page.reload':return raw('browsingContext.reload',{context,wait:'complete'});
        case 'Emulation.setDeviceMetricsOverride':return raw('browsingContext.setViewport',{context,viewport:{width:p.width,height:p.height},devicePixelRatio:p.deviceScaleFactor||1});
        case 'Page.captureScreenshot':return raw('browsingContext.captureScreenshot',{context,origin:'viewport',format:{type:'image/png'}});
        case 'Page.addScriptToEvaluateOnNewDocument':return raw('script.addPreloadScript',{functionDeclaration:`function(){${p.source}\n}`,contexts:[context]});
        case 'Runtime.evaluate':{
          // Return caught errors as data; Firefox may omit stacks on rejected promises.
          const expression=`(async()=>{try{return {value:await (0,eval)(${JSON.stringify(p.expression)})};}catch(error){return {error:{name:error.name,message:error.message,stack:error.stack||''}};}})()`;
          const result=await raw('script.evaluate',{expression,target:{context},awaitPromise:true,userActivation:!!p.userGesture,resultOwnership:'none',serializationOptions:{maxObjectDepth:100}});
          if(result.type==='exception')return {exceptionDetails:{text:result.exceptionDetails.text,exception:{description:result.exceptionDetails.text},stackTrace:result.exceptionDetails.stackTrace}};
          const decoded=decode(result.result);
          if(decoded.error)return {exceptionDetails:{text:decoded.error.message,exception:{description:decoded.error.name+': '+decoded.error.message+(decoded.error.stack?'\n'+decoded.error.stack:'')}}};
          return {result:{type:typeof decoded.value,value:decoded.value}};
        }
        case 'Input.dispatchMouseEvent':{
          const actions=[{type:'pointerMove',x:Math.round(p.x),y:Math.round(p.y),origin:'viewport'},{type:p.type==='mousePressed'?'pointerDown':'pointerUp',button:0}];
          return raw('input.performActions',{context,actions:[{type:'pointer',id:'rpg-test-mouse',parameters:{pointerType:'mouse'},actions}]});
        }
        default:throw Error(`Browser test command is not supported by Firefox: ${method}`);
      }
    };
    const noClose={close(){}};
    return {selected,process:child,profile,page:{call:pageCall,socket:noClose},browser:{socket:noClose,call:async(method)=>{
      if(method==='Browser.close')return close();
      if(method==='Target.disposeBrowserContext')return {};
      throw Error('Unexpected browser-level command: '+method);
    }},close};
  }catch(error){await close();throw error;}
}
