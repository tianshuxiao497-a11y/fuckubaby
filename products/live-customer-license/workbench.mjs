import http from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createLiveServer} from '../spot-live-pilot/live/server.mjs';
import {createFuturesServer} from '../futures-live-pilot/live/server.mjs';
import {createLicenseManager} from './license-device.mjs';

export const VERSION='0.4.1-customer';
const here=new URL('./',import.meta.url);
export async function createCustomerWorkbench({profile,port=0,spot={},futures={},licenseOptions={},
  licenseFactory=createLicenseManager,loadSavedLicense=async()=>'',saveLicense=async()=>false}={}){
  if(typeof profile!=='string'||!profile)throw new Error('CUSTOMER_PROFILE_REQUIRED');
  const token=randomBytes(32).toString('hex');let origin,spotApp,futuresApp,closing=false,closed=false;
  const stop=()=>{spotApp?.stop();futuresApp?.stop();};
  const manager=licenseFactory({...licenseOptions,profile:resolve(profile,'subscription'),onInvalid:stop});
  const active=()=>!closing&&manager.active()===true;
  let saved=false;
  const status=()=>({version:VERSION,edition:'customer',license:{...manager.status(),saved},spot:spotApp?.status()??null,futures:futuresApp?.status()??null});
  async function bodyOf(req){let size=0;const pieces=[];for await(const c of req){size+=c.length;if(size>4096)throw new Error();pieces.push(c);}return JSON.parse(Buffer.concat(pieces).toString('utf8'));}
  const server=http.createServer(async(req,res)=>{
    const frameOrigins=[spotApp,futuresApp].filter(Boolean).map(app=>new URL(app.url).origin).join(' ');
    const headers={'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer','X-Frame-Options':'DENY','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src "+(frameOrigins||"'none'")+"; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"};
    const reply=(code,value,type='application/json; charset=utf-8')=>{res.writeHead(code,{...headers,'Content-Type':type});res.end(Buffer.isBuffer(value)||typeof value==='string'?value:JSON.stringify(value));};
    if(!origin||req.headers.host!==new URL(origin).host)return reply(403,{error:'LOCAL_WORKBENCH_HOST_REQUIRED'});
    try{
      const assets=new Map([['/','ui.html'],['/ui.js','ui.js'],['/ui.css','ui.css'],['/fonts/AdaptiveNotoSansSC.woff2','../futures-live-pilot/live/fonts/AdaptiveNotoSansSC.woff2']]);
      if(req.method==='GET'&&assets.has(req.url)){const name=assets.get(req.url);return reply(200,await readFile(new URL(name,here)),name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':name.endsWith('.woff2')?'font/woff2':'text/html; charset=utf-8');}
      const provided=req.headers['x-asbw-session'];if(typeof provided!=='string'||provided.length!==token.length||!timingSafeEqual(Buffer.from(provided),Buffer.from(token)))return reply(403,{error:'LOCAL_WORKBENCH_SESSION_REQUIRED'});
      if(req.method==='GET'&&req.url==='/api/status')return reply(200,status());
      if(req.method==='GET'&&req.url==='/api/pages')return reply(200,{spot:spotApp.url,futures:futuresApp.url});
      if(req.method!=='POST'||req.headers.origin!==origin||req.headers['content-type']!=='application/json')return reply(403,{error:'LOCAL_WORKBENCH_ORIGIN_REQUIRED'});
      const body=await bodyOf(req);
      if(req.url==='/api/stop'){stop();return reply(200,status());}
      if(req.url==='/api/license-activate'){
        if(closing||Object.keys(body??{}).join(',')!=='licenseKey'||typeof body.licenseKey!=='string'||!/^[A-Za-z0-9-]{16,128}$/.test(body.licenseKey.trim()))return reply(400,{error:'SOFTWARE_LICENSE_REQUIRED'});
        // Changing a license always requires a fresh manual trading start.
        stop();await manager.activate(body.licenseKey.trim());
        if(manager.active())saved=await saveLicense(body.licenseKey.trim())===true;
        return reply(200,status());
      }
      if(req.url==='/api/license-refresh'){await manager.refresh();return reply(200,status());}
      return reply(404,{error:'UNKNOWN_CUSTOMER_ACTION'});
    }catch{return reply(400,{error:'CUSTOMER_ACTION_FAILED',license:manager.status()});}
  });
  server.requestTimeout=25000;server.headersTimeout=10000;server.maxHeadersCount=40;
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(port,'127.0.0.1',ok);});origin='http://127.0.0.1:'+server.address().port;
  try{
    spotApp=await createLiveServer({...spot,profile:spot.profile??resolve(profile,'spot'),port:0,embeddingOrigin:origin,tradingAllowed:active});
    futuresApp=await createFuturesServer({...futures,profile:futures.profile??resolve(profile,'futures'),port:0,embeddingOrigin:origin,tradingAllowed:active});
  }catch(error){manager.dispose();await spotApp?.close();await new Promise(ok=>server.close(ok));throw error;}
  const restore=Promise.resolve().then(async()=>{try{const key=await loadSavedLicense();if(typeof key==='string'&&/^[A-Za-z0-9-]{16,128}$/.test(key)){saved=true;await manager.activate(key);}}catch{/* Only the status is displayed; never log stored credentials. */}});
  return {url:origin+'/#'+token,origins:[origin,new URL(spotApp.url).origin,new URL(futuresApp.url).origin],status,stop,restore,
    async close(){if(closed)return;closed=true;closing=true;stop();manager.dispose();await new Promise(ok=>server.close(ok));const results=await Promise.allSettled([spotApp.close(),futuresApp.close()]);for(const result of results)if(result.status==='rejected')throw result.reason;}};
}
