import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createLiveServer} from '../spot-live-pilot/live/server.mjs';
import {createFuturesServer} from '../futures-live-pilot/live/server.mjs';
export const WORKBENCH_VERSION='0.3.0-personal';
const here=new URL('./',import.meta.url);
export async function createWorkbenchServer({port=0,spot={},futures={}}={}){
  const token=randomBytes(32).toString('hex');let origin,spotApp,futuresApp,closing=false;
  const status=()=>({version:WORKBENCH_VERSION,edition:'personal',spot:spotApp?.status()??null,futures:futuresApp?.status()??null});
  const stop=()=>{spotApp?.stop();futuresApp?.stop();};
  const server=http.createServer(async(req,res)=>{
    const frameOrigins=[spotApp,futuresApp].filter(Boolean).map(app=>new URL(app.url).origin).join(' ');
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src "+(frameOrigins||"'none'")+"; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const reply=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));};
    if(req.headers.host!==new URL(origin).host)return reply(403,{error:'LOCAL_WORKBENCH_HOST_REQUIRED'});
    try{
      const assets=new Map([['/','ui.html'],['/ui.js','ui.js'],['/ui.css','ui.css'],['/fonts/AdaptiveNotoSansSC.woff2','../futures-live-pilot/live/fonts/AdaptiveNotoSansSC.woff2']]);
      if(req.method==='GET'&&assets.has(req.url)){const name=assets.get(req.url);return reply(200,await readFile(new URL(name,here)),name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.woff2')?'font/woff2':'text/html; charset=utf-8');}
      const provided=req.headers['x-asbw-session'];if(typeof provided!=='string'||provided.length!==token.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(token)))return reply(403,{error:'LOCAL_WORKBENCH_SESSION_REQUIRED'});
      if(req.method==='GET'&&req.url==='/api/status')return reply(200,status());
      if(req.method==='GET'&&req.url==='/api/pages')return reply(200,{spot:spotApp.url,futures:futuresApp.url});
      if(req.method==='POST'&&req.url==='/api/stop'&&req.headers.origin===origin&&req.headers['content-type']==='application/json'){
        let bytes=0;for await(const chunk of req){bytes+=chunk.length;if(bytes>1024)throw new Error('WORKBENCH_REQUEST_TOO_LARGE');}stop();return reply(200,status());
      }
      return reply(403,{error:'LOCAL_WORKBENCH_ACTION_REFUSED'});
    }catch{return reply(400,{error:'WORKBENCH_ACTION_FAILED'});}
  });
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',ok);});origin='http://127.0.0.1:'+server.address().port;
  try{spotApp=await createLiveServer({...spot,port:0,embeddingOrigin:origin});futuresApp=await createFuturesServer({...futures,port:0,embeddingOrigin:origin});}
  catch(error){await spotApp?.close();await new Promise(ok=>server.close(ok));throw error;}
  return {url:origin+'/#'+token,origins:[origin,new URL(spotApp.url).origin,new URL(futuresApp.url).origin],status,stop,
    async close(){if(closing)return;closing=true;stop();await new Promise(ok=>server.close(ok));const results=await Promise.allSettled([spotApp.close(),futuresApp.close()]);for(const result of results)if(result.status==='rejected')throw result.reason;}};
}
