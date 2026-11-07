import { createDatabase } from './database.js';
import { createStore } from './store.js';
import { createApi } from './api.js';

let application;
export async function handler(event,context) {
  if(context)context.callbackWaitsForEmptyEventLoop=false;
  if(!application)application=createDatabase().then(db=>createApi(createStore(db),{
    allowedOrigins:(process.env.RPG_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean),secureCookies:true
  })).catch(error=>{application=null;throw error;});
  try{return await (await application)(event);}
  catch(error){console.error('DSQL initialization failed:',error.code||error.name);return {statusCode:503,headers:{'Content-Type':'application/json','Cache-Control':'no-store'},body:JSON.stringify({error:'Database unavailable; check deployment configuration'})};}
}
