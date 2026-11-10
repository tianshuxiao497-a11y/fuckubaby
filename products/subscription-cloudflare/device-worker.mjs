// Stateful device-bound verifier. Enable only after the upgraded clients are ready.
import {createPublicKey,verify,sign} from 'node:crypto';
import {readSettings,validateSubscription} from '../subscription-service/service.mjs';
import {verifyDeviceProof,hash} from '../subscription-service/device-protocol.mjs';
import {claimSeat,releaseSeat,resetSeat} from '../subscription-service/device-seats.mjs';
const headers={'Content-Type':'application/json','Cache-Control':'no-store, private','X-Content-Type-Options':'nosniff'};
const json=(body,status=200)=>Response.json(body,{status,headers});
export class LicenseDeviceSeats{
  constructor(ctx){this.storage=ctx.storage;}
  async fetch(request){
    const value=await request.json();let result;
    if(value.operation==='claim')result=await claimSeat(this.storage,value);
    else if(value.operation==='release')result=await releaseSeat(this.storage,value);
    else if(value.operation==='reset')result=await resetSeat(this.storage,value);
    else return json({ok:false},400);
    return json(result);
  }
}
export function createDeviceWorker({fetchImpl=(...args)=>globalThis.fetch(...args),now=Date.now}={}){
  return {async fetch(request,env){
    const url=new URL(request.url);
    if(url.search||!['/api/validate','/api/health','/api/device-reset'].includes(url.pathname))return json({active:false,reason:'not_found'},404);
    let settings;
    try{
      settings=readSettings(env);
      if(settings.companyId!=='biz_KAiAyPYUEaP2l1'||settings.productId!=='prod_KIUnn09xAwsal'||settings.planIds.join(',')!=='plan_hDSOoWy649Nus'||!env.ASB_DEVICE_SEATS?.idFromName||!env.ASB_RATE_LIMITER?.limit)throw new Error();
    }catch{return json({active:false,reason:'service_not_configured'},503);}
    if(url.pathname==='/api/health')return request.method==='GET'?json({service:'adaptive-spot-license',version:'0.5.0-device',configured:true,mode:'BINANCE_SPOT_TESTNET_ONLY',deviceLimit:1,concurrentSessionLimit:1,leaseMaxSeconds:120,refreshSeconds:30}):json({active:false},405);
    if(request.method!=='POST')return json({active:false,reason:'method_not_allowed'},405);
    if(request.headers.has('Origin'))return json({active:false,reason:'origin_not_allowed'},403);
    if(!/^application\/json(?:;|$)/i.test(request.headers.get('Content-Type')??'')||Number(request.headers.get('Content-Length'))>4096)return json({active:false,reason:'invalid_request'},400);
    let body;
    try{
      const reader=request.body.getReader();let size=0;const pieces=[];
      for(;;){const part=await reader.read();if(part.done)break;size+=part.value.byteLength;if(size>4096){await reader.cancel();throw new Error();}pieces.push(Buffer.from(part.value));}
      body=JSON.parse(Buffer.concat(pieces).toString());
    }catch{return json({active:false,reason:'invalid_request'},400);}
    try{
      const rate=await env.ASB_RATE_LIMITER.limit({key:'device-'+hash(request.headers.get('CF-Connecting-IP')??'unknown')});
      if(rate.success!==true)return json({active:false,reason:'rate_limited'},429);
    }catch{return json({active:false,reason:'verification_unavailable'},503);}
    async function seat(licenseHash,value){
      const stub=env.ASB_DEVICE_SEATS.get(env.ASB_DEVICE_SEATS.idFromName(licenseHash));
      const response=await stub.fetch('https://seat.internal/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(value)});
      if(!response.ok)throw new Error('seat_unavailable');return response.json();
    }
    if(url.pathname==='/api/device-reset'){
      if(!body||Object.keys(body).sort().join(',')!=='expectedDeviceHash,licenseHash,newDeviceHash,nonce,signature,timestamp'||!['licenseHash','expectedDeviceHash','newDeviceHash'].every(k=>/^[a-f0-9]{64}$/.test(body[k]??''))||!/^[a-f0-9-]{36}$/.test(body.nonce??'')||!Number.isSafeInteger(body.timestamp)||Math.abs(now()-body.timestamp)>30000||!/^[A-Za-z0-9_-]{80,100}$/.test(body.signature??''))return json({active:false,reason:'invalid_admin_request'},400);
      const payload=JSON.stringify(['AdaptiveSpotBot.DeviceReset.v2',settings.companyId,settings.productId,body.licenseHash,body.expectedDeviceHash,body.newDeviceHash,body.nonce,body.timestamp]);
      if(!verify(null,Buffer.from(payload),createPublicKey(settings.key),Buffer.from(body.signature,'base64url')))return json({active:false,reason:'admin_signature_required'},403);
      try{const result=await seat(body.licenseHash,{operation:'reset',expectedDeviceHash:body.expectedDeviceHash,newDeviceHash:body.newDeviceHash,nonce:body.nonce,now:now()});return json(result,result.ok?200:409);}catch{return json({ok:false,reason:'seat_unavailable'},503);}
    }
    if(!body?.devicePublicKey||!body?.deviceSignature)return json({active:false,reason:'client_upgrade_required'},426);
    const proof=verifyDeviceProof(body,now());if(!proof)return json({active:false,reason:'device_proof_invalid'},403);
    if(body.action==='release'){
      try{const result=await seat(proof.licenseHash,{operation:'release',deviceHash:proof.deviceHash,session:body.session});return json(result,result.ok?200:409);}catch{return json({ok:false,reason:'seat_unavailable'},503);}
    }
    const transport=async(url,init)=>{const r=await fetchImpl(url,{...init,redirect:'manual'});if(r.status>=300&&r.status<400){await r.body?.cancel();throw new Error('redirect_refused');}return r;};
    const checked=await validateSubscription({licenseKey:body.licenseKey,session:body.session,nonce:body.nonce},{settings,fetchImpl:transport,now});
    if(checked.status!==200)return json(checked.body,checked.status);
    // This token was generated here, from the freshly checked Whop membership.
    const claims=JSON.parse(Buffer.from(checked.body.token.split('.')[0],'base64url').toString());
    let reserved;
    try{reserved=await seat(proof.licenseHash,{operation:'claim',deviceHash:proof.deviceHash,session:body.session,nonce:body.nonce,now:now(),paidUntil:claims.paidUntil});}catch{return json({active:false,reason:'seat_unavailable'},503);}
    if(!reserved.ok)return json({active:false,reason:reserved.reason,retryAfterSeconds:reserved.retryAfterSeconds??null},409);
    const issuedAt=now(),expiresAt=Math.min(reserved.expiresAt,claims.paidUntil,issuedAt+120000);
    if(expiresAt<=issuedAt)return json({active:false,reason:'membership_inactive_or_not_eligible'},403);
    const payload=Buffer.from(JSON.stringify({...claims,v:2,deviceHash:proof.deviceHash,issuedAt,expiresAt})).toString('base64url');
    return json({active:true,token:payload+'.'+sign(null,Buffer.from(payload),settings.key).toString('base64url')});
  }};
}
