// Shared proof format. No hardware serials or merchant secrets cross this boundary.
import {createHash,createPublicKey,sign,verify} from 'node:crypto';
export const DEVICE_PROTOCOL=2;
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function canonicalProof(body){
  return JSON.stringify(['AdaptiveSpotBot.Device.v2',body.action??'validate',hash(body.licenseKey),body.devicePublicKey,body.session,body.nonce,body.timestamp]);
}
export function attachProof(request,privateKey){
  const publicKey=createPublicKey(privateKey);
  if(publicKey.asymmetricKeyType!=='ed25519')throw new Error('ed25519_device_key_required');
  const body={...request,devicePublicKey:publicKey.export({format:'der',type:'spki'}).toString('base64url')};
  return {...body,deviceSignature:sign(null,Buffer.from(canonicalProof(body)),privateKey).toString('base64url')};
}
export function verifyDeviceProof(body,now=Date.now()){
  if(!body||typeof body!=='object'||Array.isArray(body)||Object.keys(body).some(k=>!['licenseKey','session','nonce','timestamp','devicePublicKey','deviceSignature','action'].includes(k)))return null;
  if(!['validate','release'].includes(body.action??'validate')||!/^[A-Za-z0-9-]{16,128}$/.test(body.licenseKey??'')||
    !/^[a-f0-9-]{36}$/.test(body.session??'')||!/^[a-f0-9-]{36}$/.test(body.nonce??'')||!Number.isSafeInteger(body.timestamp)||Math.abs(now-body.timestamp)>45000||
    !/^[A-Za-z0-9_-]{50,80}$/.test(body.devicePublicKey??'')||!/^[A-Za-z0-9_-]{80,100}$/.test(body.deviceSignature??''))return null;
  try{
    const key=createPublicKey({key:Buffer.from(body.devicePublicKey,'base64url'),format:'der',type:'spki'});
    if(key.asymmetricKeyType!=='ed25519'||key.export({type:'spki',format:'der'}).toString('base64url')!==body.devicePublicKey||!verify(null,Buffer.from(canonicalProof(body)),key,Buffer.from(body.deviceSignature,'base64url')))return null;
    return {deviceHash:hash(body.devicePublicKey),licenseHash:hash(body.licenseKey)};
  }catch{return null;}
}
