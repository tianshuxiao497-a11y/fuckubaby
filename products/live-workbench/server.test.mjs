import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createWorkbenchServer} from './server.mjs';
test('one local workbench embeds only its two isolated engines and switching does not create broker calls',async t=>{
  const root=await mkdtemp(join(tmpdir(),'asbw-')),calls=[];const factory=()=>{calls.push('unexpected-broker');throw new Error('NO_BROKER_ACCESS');};const app=await createWorkbenchServer({spot:{profile:join(root,'spot'),clientFactory:factory},futures:{profile:join(root,'futures'),clientFactory:factory}});t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});const url=new URL(app.url),headers={'x-asbw-session':url.hash.slice(1)};
  assert.equal((await fetch(url.origin+'/api/pages')).status,403);const pages=await (await fetch(url.origin+'/api/pages',{headers})).json();assert.notEqual(new URL(pages.spot).origin,new URL(pages.futures).origin);
  for(const page of Object.values(pages)){const r=await fetch(page);assert.equal(r.status,200);assert.equal(r.headers.get('x-frame-options'),null);assert.ok(r.headers.get('content-security-policy').includes('frame-ancestors '+url.origin+';'));assert.ok(!r.headers.get('content-security-policy').includes('frame-ancestors *'));}
  const shell=await (await fetch(url.origin)).text();assert.ok(shell.includes('spot-tab')&&shell.includes('futures-tab')&&shell.includes('stop-all'));assert.ok(!shell.includes(url.hash.slice(1)));
  assert.equal((await fetch(url.origin+'/api/stop',{method:'POST',headers:{...headers,Origin:'https://attacker.invalid','Content-Type':'application/json'},body:'{}'})).status,403);
  const stopped=await (await fetch(url.origin+'/api/stop',{method:'POST',headers:{...headers,Origin:url.origin,'Content-Type':'application/json'},body:'{}'})).json();assert.equal(stopped.spot.running,false);assert.equal(stopped.futures.running,false);assert.equal(calls.length,0);
});
