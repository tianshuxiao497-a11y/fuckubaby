// Only public verification material ships to buyers. No Whop merchant key.
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
export const AUDIENCE = 'AdaptiveSpotBot.Testnet.Subscription.v1';
export const MAX_LEASE_MS = 120000;
export const REFRESH_MS = 30000;
// The service itself may spend eight seconds checking Whop. Allow transport
// headroom without extending the signed lease or its paid-term deadline.
export const LICENSE_REQUEST_MS = 20000;
export const publicConfig = JSON.parse(readFileSync(new URL('./license-config.json',import.meta.url),'utf8'));
export function validatePublicConfig(c) {
  if (!c || Object.keys(c).some(k=>!['endpoint','publicKey','companyId','productId','planIds'].includes(k))) throw new Error('License service is not configured.');
  let url, key;
  try {
    if(typeof c.publicKey!=='string' || !c.publicKey.startsWith('-----BEGIN PUBLIC KEY-----') || c.publicKey.includes('PRIVATE KEY')) throw new Error();
    url=new URL(c.endpoint); key=createPublicKey(c.publicKey);
  } catch { throw new Error('License service is not configured.'); }
  if (url.protocol!=='https:' || url.username || url.password || url.hash || url.search || url.pathname!=='/api/validate' ||
      ['localhost','127.0.0.1','::1','[::1]'].includes(url.hostname) || key.asymmetricKeyType!=='ed25519' ||
      !/^biz_[A-Za-z0-9]+$/.test(c.companyId) || !/^prod_[A-Za-z0-9]+$/.test(c.productId) || !Array.isArray(c.planIds) || !c.planIds.length || c.planIds.some(p=>!/^plan_[A-Za-z0-9]+$/.test(p))) throw new Error('License service is not configured.');
  return key;
}
export function verifyLease(token,{config=publicConfig,session,nonce,licenseKey,now=Date.now()}={}) {
  const key=validatePublicConfig(config);
  if (typeof token!=='string' || token.length>8192 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) throw new Error('Invalid signed subscription lease.');
  const [payload,signature]=token.split('.');
  if(!verify(null,Buffer.from(payload),key,Buffer.from(signature,'base64url'))) throw new Error('Invalid subscription signature.');
  const c=JSON.parse(Buffer.from(payload,'base64url').toString('utf8'));
  if(c.v!==1 || c.aud!==AUDIENCE || c.companyId!==config.companyId || c.productId!==config.productId || !config.planIds.includes(c.planId) || c.session!==session ||
      (nonce!==undefined && c.nonce!==nonce) || (licenseKey!==undefined && c.licenseHash!==createHash('sha256').update(licenseKey).digest('hex')) ||
      ![c.issuedAt,c.expiresAt,c.paidUntil].every(Number.isSafeInteger) || c.expiresAt<=now || c.issuedAt>now+10000 ||
      c.expiresAt<=c.issuedAt || c.expiresAt-c.issuedAt>MAX_LEASE_MS || c.expiresAt>c.paidUntil || !/^[a-f0-9-]{36}$/.test(c.nonce)) throw new Error('Subscription lease expired or mismatched.');
  return c;
}
export function createLeaseGuard({config=publicConfig,session,now=Date.now,mono=()=>performance.now()}={}) {
  let claims=null,deadline=0,lastIssue=-Infinity,cleared=false;
  const nonces=new Set();
  return {
    accept(token,extra={}) {
      if(cleared) throw new Error('Subscription session is stopped.');
      const next=verifyLease(token,{config,session,...extra,now:now()});
      if(next.issuedAt<lastIssue || next.issuedAt===lastIssue && nonces.has(next.nonce)) throw new Error('Replayed subscription lease.');
      if(next.issuedAt>lastIssue) nonces.clear();
      if(nonces.size>=32) throw new Error('Too many subscription grants in one clock tick.');
      nonces.add(next.nonce);
      claims=next; lastIssue=next.issuedAt;
      deadline=mono()+Math.min(next.expiresAt-now(),next.expiresAt-next.issuedAt,MAX_LEASE_MS);
      return next;
    },
    active:()=>Boolean(!cleared && claims && now()<claims.expiresAt && mono()<deadline),
    clear:()=>{ cleared=true; claims=null; deadline=0; },
    claims:()=>claims
  };
}
export function createLicenseManager({config=publicConfig,fetchImpl=fetch,now=Date.now,mono=()=>performance.now(),onChange=()=>{},onInvalid=()=>{},autoMonitor=true}={}) {
  const session=randomUUID(); let guard=createLeaseGuard({config,session,now,mono});
  let licenseKey='',token='',phase='not_activated',inFlight,disposed=false,generation=0,nextCheck=Infinity;
  let cancellation=false,lastErrorCode=null,lastRequestMs=null;
  let configured=false;try{validatePublicConfig(config);configured=true;}catch{}
  function status() { const c=guard.claims(); return {type:'license',configured,active:guard.active(),status:phase,paidUntil:c?.paidUntil??null,leaseUntil:c?.expiresAt??null,cancelAtPeriodEnd:cancellation,lastErrorCode,lastRequestMs}; }
  function invalidate(reason) {
    const was=guard.active() || phase==='active'; guard.clear(); token='';phase=reason; nextCheck=Infinity;
    onChange(status()); if(was) Promise.resolve(onInvalid(reason)).catch(()=>{});
  }
  async function refresh() {
    if(disposed) throw new Error('License manager closed.');
    if(inFlight) return inFlight;
    const epoch=generation;
    inFlight=Promise.resolve().then(async()=>{
      let stage='configuration';const started=mono();
      try {
        validatePublicConfig(config);
        stage='license_format';
        if(!/^[A-Za-z0-9-]{16,128}$/.test(licenseKey)) throw new Error('Missing license key');
        const nonce=randomUUID();
        stage='request';
        const r=await fetchImpl(config.endpoint,{method:'POST',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(LICENSE_REQUEST_MS),headers:{'Content-Type':'application/json'},body:JSON.stringify({licenseKey,session,nonce})});
        if(!r.ok) { stage='http_'+r.status; await r.body?.cancel(); throw new Error('Subscription denied or unavailable'); }
        stage='response';
        const result=await readLimitedJson(r,16384); if(result.active!==true) throw new Error('Subscription denied');
        if(disposed || epoch!==generation) throw new Error('Subscription operation cancelled');
        stage='signature';
        const c=guard.accept(result.token,{nonce,licenseKey}); token=result.token;phase='active';cancellation=c.cancelAtPeriodEnd===true;
        lastErrorCode=null;lastRequestMs=Math.max(0,Math.round(mono()-started));
        nextCheck=mono()+REFRESH_MS; onChange(status()); return status();
      } catch(error) {
        if(!disposed && epoch===generation) {
          lastErrorCode=stage==='request' ? (['TimeoutError','AbortError'].includes(error.name)?'request_timeout':'network_unavailable') : stage;
          lastRequestMs=Math.max(0,Math.round(mono()-started)); invalidate('verification_required');
        }
        throw new Error('订阅核验未通过（'+(lastErrorCode||'verification_required')+'）。请检查授权或网络；交易保持锁定，不会自动恢复。');
      }
    }).finally(()=>{inFlight=null;});
    return inFlight;
  }
  async function activate(key) {
    if(inFlight) throw new Error('Subscription verification is already in progress.');
    generation++;guard.clear();guard=createLeaseGuard({config,session,now,mono}); token='';phase='checking';lastErrorCode=null;licenseKey=String(key??'').trim();onChange(status());
    return refresh();
  }
  async function tick() {
    if(disposed || phase!=='active') return;
    if(!guard.active()) { invalidate('expired'); return; }
    if(mono()>=nextCheck) await refresh().catch(()=>{});
  }
  const timer=autoMonitor ? setInterval(()=>{tick().catch(()=>{});},250) : null; timer?.unref();
  return {activate,refresh,tick,status,session,token:()=>token,active:()=>guard.active(),
    dispose(){disposed=true;generation++;if(timer)clearInterval(timer);guard.clear();token='';licenseKey='';}};
}

async function readLimitedJson(response,maximum) {
  if(Number(response.headers.get('content-length'))>maximum) throw new Error('Oversized license response.');
  const reader=response.body?.getReader();if(!reader)throw new Error('Missing subscription response.');
  let size=0;const chunks=[];
  try {
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maximum)throw new Error('Oversized license response.');chunks.push(Buffer.from(value));}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch(error) {await reader.cancel().catch(()=>{});throw error;}
  finally {reader.releaseLock();}
}
