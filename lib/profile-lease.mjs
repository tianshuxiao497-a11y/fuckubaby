import {createServer} from 'node:net';
import {createHash} from 'node:crypto';

// The PID marker remains a second guard. Never fall back on an occupied port:
// only a Windows system-reserved port (EACCES) permits another candidate.
export async function acquireProfileLease(identity,{create=createServer}={}){
  for(let attempt=0;attempt<8;attempt++){
    const digest=createHash('sha256').update(attempt?identity+':reserved-port:'+attempt:identity).digest();
    const port=attempt?10240+digest.readUInt32BE(0)%31000:42000+digest.readUInt32BE(0)%17000;
    const lease=create(socket=>socket.destroy());
    try{await new Promise((ok,bad)=>{lease.once('error',bad);lease.listen({host:'127.0.0.1',port,exclusive:true},()=>{lease.removeListener('error',bad);ok();});});lease.unref();return lease;}
    catch(error){lease.close(()=>{});if(error.code!=='EACCES')throw error;}
  }
  throw new Error('PROFILE_LOOPBACK_PERMISSION_DENIED');
}
