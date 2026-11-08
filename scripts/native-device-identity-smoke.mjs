// Verify native OS identity availability without logging any identifier or key.
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {machineIdentity,loadDeviceIdentity} from '../products/adaptive-spot-desktop/device-identity.mjs';
const profile=await mkdtemp(join(tmpdir(),'asb-native-device-'));
try {
  const first=await machineIdentity(),second=await machineIdentity();
  assert.equal(first.length,32);assert.deepEqual(second,first);
  const a=await loadDeviceIdentity(profile),b=await loadDeviceIdentity(profile);
  assert.match(a.deviceHash,/^[a-f0-9]{64}$/);assert.equal(b.deviceHash,a.deviceHash);
  const saved=await readFile(join(profile,'device','identity-v2.json'),'utf8');
  assert.doesNotMatch(saved,/PRIVATE KEY/);
  await assert.rejects(loadDeviceIdentity(profile,{machineProvider:async()=>randomBytes(32)}),/does_not_match_machine/);
  assert.equal(await readFile(join(profile,'device','identity-v2.json'),'utf8'),saved);
  const report={platform:process.platform,arch:process.arch,stableMachineIdentity:true,persistentDeviceIdentity:true,copiedProfileRejected:true,privateMaterialLogged:false};
  if(process.argv[2])await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify(report));
} finally {
  // mkdtemp returned this process's dedicated directory; never remove a user profile.
  if(!profile.startsWith(join(tmpdir(),'asb-native-device-')))throw new Error('unexpected_test_directory');
  await rm(profile,{recursive:true,force:true});
}
