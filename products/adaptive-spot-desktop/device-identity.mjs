// Stable per-install Ed25519 identity sealed to the local OS machine identifier.
// Copying this profile to a different machine does not decrypt its private key.
// This is copy resistance for the unmodified app, not a tamper-proof hardware claim.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdir,open,lstat} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash,randomBytes,scryptSync,createCipheriv,createDecipheriv,generateKeyPairSync,createPrivateKey,createPublicKey} from 'node:crypto';
const run=promisify(execFile);
export async function machineIdentity(platform=process.platform){
  let value;
  if(platform==='win32'){
    const {stdout}=await run(resolve(process.env.SystemRoot??'C:/Windows','System32/reg.exe'),['query','HKLM\\SOFTWARE\\Microsoft\\Cryptography','/v','MachineGuid','/reg:64'],{windowsHide:true,timeout:8000,maxBuffer:16384});
    value=/MachineGuid\s+REG_SZ\s+([A-Fa-f0-9-]{16,80})/.exec(stdout)?.[1];
  }else if(platform==='darwin'){
    const {stdout}=await run('/usr/sbin/ioreg',['-rd1','-c','IOPlatformExpertDevice'],{timeout:8000,maxBuffer:262144});
    value=/"IOPlatformUUID"\s*=\s*"([A-Fa-f0-9-]{16,80})"/.exec(stdout)?.[1];
  }else if(platform==='linux')value=(await readFile('/etc/machine-id','utf8')).trim();
  else throw new Error('unsupported_device_platform');
  if(typeof value!=='string'||!/^[A-Fa-f0-9-]{16,80}$/.test(value)||/^0+$/.test(value))throw new Error('machine_identity_unavailable');
  return createHash('sha256').update('AdaptiveSpotBot.Device.v2\0'+platform+'\0'+value.toLowerCase()).digest();
}
export async function loadDeviceIdentity(profile,{machineProvider=machineIdentity}={}){
  const machine=await machineProvider();
  if(!Buffer.isBuffer(machine)||machine.length!==32)throw new Error('machine_identity_unavailable');
  const dir=resolve(profile,'device'),path=resolve(dir,'identity-v2.json');
  await mkdir(dir,{recursive:true,mode:0o700});const ds=await lstat(dir);if(!ds.isDirectory()||ds.isSymbolicLink())throw new Error('unsafe_device_directory');
  async function load(){
    const stat=await lstat(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>4096)throw new Error('unsafe_device_identity');
    const stored=JSON.parse(await readFile(path,'utf8'));
    if(stored.version!==2||Object.keys(stored).sort().join(',')!=='ciphertext,iv,salt,tag,version')throw new Error('invalid_device_identity');
    const salt=Buffer.from(stored.salt,'base64'),iv=Buffer.from(stored.iv,'base64'),tag=Buffer.from(stored.tag,'base64');
    if(salt.length!==16||iv.length!==12||tag.length!==16)throw new Error('invalid_device_identity');
    const cipher=createDecipheriv('aes-256-gcm',scryptSync(machine,salt,32),iv);cipher.setAAD(Buffer.from('AdaptiveSpotBot.Device.v2'));cipher.setAuthTag(tag);
    let bytes;try{bytes=Buffer.concat([cipher.update(Buffer.from(stored.ciphertext,'base64')),cipher.final()]);}catch{throw new Error('device_identity_does_not_match_machine');}
    const key=createPrivateKey({key:bytes,format:'der',type:'pkcs8'});if(key.asymmetricKeyType!=='ed25519')throw new Error('invalid_device_identity');
    return {privateKey:key,deviceHash:createHash('sha256').update(createPublicKey(key).export({format:'der',type:'spki'}).toString('base64url')).digest('hex')};
  }
  try{return await load();}catch(e){if(e.code!=='ENOENT')throw e;}
  const {privateKey}=generateKeyPairSync('ed25519'),salt=randomBytes(16),iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',scryptSync(machine,salt,32),iv);cipher.setAAD(Buffer.from('AdaptiveSpotBot.Device.v2'));
  const ciphertext=Buffer.concat([cipher.update(privateKey.export({format:'der',type:'pkcs8'})),cipher.final()]);
  const saved=JSON.stringify({version:2,salt:salt.toString('base64'),iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),ciphertext:ciphertext.toString('base64')});
  let fd;try{fd=await open(path,'wx',0o600);}catch(e){if(e.code==='EEXIST')return load();throw e;}
  try{await fd.writeFile(saved);await fd.sync();}finally{await fd.close();}
  return load();
}
