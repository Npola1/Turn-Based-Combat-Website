import { randomBytes } from 'node:crypto';
import { SaveError, MAX_WRITE_BYTES } from './store.js';

// Shared by the real Lambda entry point and the local HTTP preview adapter.
// Only CloudFront's signed, overwritten site header is trusted in AWS.
export function createApi(store, { allowedOrigins = [], secureCookies = true, cookiePath = '/', inlineResponseBytes = 1024 * 1024, logger = console } = {}) {
  if (typeof cookiePath !== 'string' || !cookiePath.startsWith('/') || /[;\x00-\x20\x7f]/.test(cookiePath)) throw Error('Invalid save cookie path');
  return async function api(event) {
    const headers = Object.fromEntries(Object.entries(event.headers || {}).map(([k,v])=>[k.toLowerCase(),v]));
    const method = event.requestContext?.http?.method || event.httpMethod || 'GET';
    const path = event.rawPath || event.path || '/';
    const response = (statusCode,value,cookie) => ({statusCode,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'},...(cookie?{cookies:[cookie]}:{}),body:JSON.stringify(value)});
    let cookie;
    try {
      const cookieText = [...(event.cookies || []), headers.cookie || ''].join('; ');
      let player = /(?:^|;\s*)rpg_player=([a-f0-9]{64})(?:;|$)/.exec(cookieText)?.[1];
      if (!player) { player=randomBytes(32).toString('hex');cookie=`rpg_player=${player}; HttpOnly;${secureCookies?' Secure;':''} SameSite=Strict; Path=${cookiePath}; Max-Age=31536000`; }
      const origin=headers.origin, site=headers['x-rpg-site-origin'];
      if(origin && !allowedOrigins.includes(origin) && origin!==site)throw new SaveError('Origin rejected',403);
      let result;
      if (method==='GET' && path==='/api/saves') result=await store.list(player);
      else if(method==='GET' && /^\/api\/saves\/[1-6]$/.test(path))result=await store.load(player,Number(path.at(-1)));
      else if(method==='GET' && path==='/api/history')result=await store.history(player);
      else if(method==='GET' && /^\/api\/responses\/[a-f0-9-]{36}\/\d+$/.test(path)){const p=path.split('/');return response(200,await store.responsePart(player,p[3],Number(p[4])),cookie);}
      else if((method==='PUT'&&/^\/api\/saves\/[1-6]$/.test(path))||(method==='POST'&&['/api/autosave','/api/battles/events','/api/uploads'].includes(path))||(method==='POST'&&/^\/api\/uploads\/[a-f0-9-]{36}\/commit$/.test(path))){
        if(!headers['content-type']?.toLowerCase().startsWith('application/json'))throw new SaveError('JSON required',415);
        const bytes=Buffer.from(event.body||'',event.isBase64Encoded?'base64':'utf8');
        if(bytes.length>MAX_WRITE_BYTES)throw new SaveError('Save too large',413);
        let payload;try{payload=JSON.parse(bytes.toString('utf8'));}catch{throw new SaveError('Invalid request data');}
        await store.maintenance(player);
        if(path==='/api/uploads')await store.stageUpload(player,payload);
        else if(path.startsWith('/api/uploads/'))await store.commitUpload(player,path.split('/')[3]);
        else await store.write(player,path,payload);
        return response(200,{ok:true},cookie);
      } else return response(404,{error:'Unknown endpoint'},cookie);
      const json=JSON.stringify(result);
      if(Buffer.byteLength(json)>inlineResponseBytes)result=await store.stageResponse(player,Buffer.from(json));
      return response(200,result,cookie);
    } catch(error) {
      if(!(error instanceof SaveError))logger.error('Save API failed:',error.code||error.name);
      return response(error instanceof SaveError?error.status:503,{error:error instanceof SaveError?error.message:'Storage temporarily unavailable; please retry'},cookie);
    }
  };
}
