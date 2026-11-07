// Local development preview. Production /api/* runs server/lambda.js on Lambda.
import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { resolve,extname,sep } from 'node:path';
import { createDatabase } from './database.js';
import { initializeSchema } from './initialize-schema.js';
import { createStore,MAX_WRITE_BYTES } from './store.js';
import { createApi } from './api.js';
const root=resolve(import.meta.dirname,'..');
const database=await createDatabase({localPath:process.env.RPG_LOCAL_DB||resolve(root,'data/local-postgres')});
if(database.dialect!=='dsql')await initializeSchema(database);
const store=createStore(database),types={'.css':'text/css; charset=utf-8','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.jfif':'image/jpeg','.webm':'video/webm','.mp3':'audio/mpeg','.wav':'audio/wav'};
const server=http.createServer(async(req,res)=>{
  function reply(status,value){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(value));}
  try{
    const url=new URL(req.url,'http://localhost');
    if(url.pathname.startsWith('/api/')){
      const chunks=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>MAX_WRITE_BYTES)return reply(413,{error:'Save too large'});chunks.push(chunk);}
      const origin='http://'+req.headers.host;
      const api=createApi(store,{allowedOrigins:[origin],secureCookies:false});
      const result=await api({rawPath:url.pathname,headers:{...req.headers,'x-rpg-site-origin':origin},requestContext:{http:{method:req.method}},body:Buffer.concat(chunks).toString('utf8')});
      res.writeHead(result.statusCode,{...result.headers,...(result.cookies?{'Set-Cookie':result.cookies}:{})});return res.end(result.body);
    }
    if(!['GET','HEAD'].includes(req.method))return reply(405,{error:'Method not allowed'});
    const relative=decodeURIComponent(url.pathname).replace(/^\/+/, '')||'index.html';
    if(relative.split('/').some(p=>p.startsWith('.'))||/^(server|scripts|test|test-results|data|aws|dist|node_modules)(\/|$)/.test(relative)||['package.json','package-lock.json','README.md'].includes(relative))return reply(404,{error:'Not found'});
    const file=resolve(root,relative);
    if(!file.startsWith(root+sep)||!statSync(file).isFile())return reply(404,{error:'Not found'});
    const size=statSync(file).size,range=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range||'');
    const start=range?Number(range[1]):0,end=range&&range[2]?Math.min(Number(range[2]),size-1):size-1;
    if(start>end||start>=size){res.writeHead(416,{'Content-Range':`bytes */${size}`});return res.end();}
    res.writeHead(range?206:200,{'Content-Type':types[extname(file)]||'application/octet-stream','Accept-Ranges':'bytes','Content-Length':end-start+1,...(range?{'Content-Range':`bytes ${start}-${end}/${size}`}:{})});
    if(req.method==='HEAD')return res.end();createReadStream(file,{start,end}).pipe(res);
  }catch{if(!res.headersSent)reply(404,{error:'Not found'});else res.destroy();}
});
server.listen(Number(process.env.PORT||3000),process.env.HOST||'127.0.0.1',()=>console.log('Game running at http://localhost:'+(process.env.PORT||3000)+' ('+database.dialect+')'));
let closing=false;async function close(){if(closing)return;closing=true;server.closeAllConnections();server.close();await store.close();}
process.once('SIGTERM',()=>close().then(()=>process.exit(0)));process.once('SIGINT',()=>close().then(()=>process.exit(0)));
