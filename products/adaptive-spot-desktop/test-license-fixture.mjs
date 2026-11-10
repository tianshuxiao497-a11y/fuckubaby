// Unit-test dependency only. Excluded from the installed engine payload.
export function testLicense() {
  return {status:()=>({type:'license',active:true,status:'active'}),active:()=>true,
    refresh:async()=>({active:true}),activate:async()=>({active:true}),dispose(){},session:'test-session',token:()=>''};
}
