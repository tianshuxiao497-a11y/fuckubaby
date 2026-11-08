// Each license hash maps to ONE strongly consistent Durable Object.
// Never use a per-process Map or eventually consistent KV for seat allocation.
const TTL=120000;
export async function claimSeat(storage,{deviceHash,session,nonce,now,paidUntil}){
  if(!/^[a-f0-9]{64}$/.test(deviceHash??'')||!Number.isSafeInteger(now)||!Number.isSafeInteger(paidUntil)||paidUntil<=now)return {ok:false,reason:'invalid_seat_request'};
  return storage.transaction(async tx=>{
    const seat=await tx.get('seat')??{};
    if(seat.blockedUntil>now)return {ok:false,reason:'device_reset_wait',retryAfterSeconds:Math.ceil((seat.blockedUntil-now)/1000)};
    if(seat.deviceHash&&seat.deviceHash!==deviceHash)return {ok:false,reason:'device_limit_reached'};
    const recent=(seat.recentNonces??[]).filter(x=>x.at>now-60000);
    if(recent.some(x=>x.nonce===nonce))return {ok:false,reason:'replayed_request'};
    if(seat.session&&seat.session!==session&&seat.activeUntil>now)return {ok:false,reason:'session_in_use',retryAfterSeconds:Math.ceil((seat.activeUntil-now)/1000)};
    const expiresAt=Math.min(now+TTL,paidUntil);
    await tx.put('seat',{...seat,deviceHash,session,activeUntil:expiresAt,boundAt:seat.boundAt??now,lastSeen:now,recentNonces:[...recent,{nonce,at:now}].slice(-32)});
    return {ok:true,deviceHash,expiresAt};
  });
}
export async function releaseSeat(storage,{deviceHash,session}){
  return storage.transaction(async tx=>{
    const seat=await tx.get('seat');
    if(!seat||seat.deviceHash!==deviceHash||seat.session!==session)return {ok:false,reason:'seat_mismatch'};
    // Releasing the running session NEVER removes the persistent device binding.
    await tx.put('seat',{...seat,session:null,activeUntil:0});return {ok:true};
  });
}
export async function resetSeat(storage,{expectedDeviceHash,newDeviceHash,nonce,now}){
  if(!/^[a-f0-9]{64}$/.test(newDeviceHash??'')||!Number.isSafeInteger(now))return {ok:false,reason:'target_device_required'};
  return storage.transaction(async tx=>{
    const seat=await tx.get('seat');
    if(!seat||seat.deviceHash!==expectedDeviceHash)return {ok:false,reason:'binding_changed'};
    if(seat.lastResetNonce===nonce)return {ok:false,reason:'replayed_reset'};
    await tx.put('seat',{deviceHash:newDeviceHash,session:null,activeUntil:0,boundAt:now,blockedUntil:Math.max(now,seat.activeUntil??now),lastResetNonce:nonce,lastResetAt:now});
    // The old device's outstanding signed lease may remain usable for <=120s.
    return {ok:true,oldLeaseMayRemainUntil:seat.activeUntil??now};
  });
}
