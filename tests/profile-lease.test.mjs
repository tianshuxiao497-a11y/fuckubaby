import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {acquireProfileLease} from '../lib/profile-lease.mjs';
function factory(errors,ports){return ()=>{const s=new EventEmitter();s.listen=(args,ok)=>{ports.push(args.port);queueMicrotask(()=>{const code=errors.shift();if(code)s.emit('error',Object.assign(new Error(code),{code}));else ok();});};s.unref=()=>{};s.close=ok=>ok();return s;};}
test('a reserved loopback port uses the same deterministic fallback without bypassing an occupied lease',async()=>{const a=[],b=[];await acquireProfileLease('fabricated-profile',{create:factory(['EACCES',null],a)});await acquireProfileLease('fabricated-profile',{create:factory(['EACCES',null],b)});assert.deepEqual(a,b);assert.notEqual(a[0],a[1]);const busy=[];await assert.rejects(acquireProfileLease('fabricated-profile',{create:factory(['EADDRINUSE'],busy)}),{code:'EADDRINUSE'});assert.equal(busy.length,1);});
test('persistent system denial stops after bounded attempts',async()=>{const ports=[];await assert.rejects(acquireProfileLease('fabricated-profile',{create:factory(Array(8).fill('EACCES'),ports)}),/PROFILE_LOOPBACK_PERMISSION_DENIED/);assert.equal(ports.length,8);});
