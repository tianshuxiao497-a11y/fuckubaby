import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
const [executable,output]=process.argv.slice(2);
if(!executable||!output)throw new Error('NATIVE_EXECUTABLE_AND_OUTPUT_REQUIRED');
const destination=resolve(output);await mkdir(destination,{recursive:true});
const child=spawn(resolve(executable),['--self-test='+destination],{env:{...process.env,ELECTRON_ENABLE_LOGGING:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr='';child.stderr.on('data',value=>{stderr=(stderr+value).slice(-4000);});
const timeout=setTimeout(()=>child.kill('SIGTERM'),90000);
const code=await new Promise((done,reject)=>{child.once('error',reject);child.once('close',done);});clearTimeout(timeout);
if(code!==0){console.error(stderr.slice(-2000));throw new Error('NATIVE_WORKBENCH_SELF_TEST_FAILED_'+code);}
const result=JSON.parse(await readFile(resolve(destination,'RESULT.json'),'utf8'));
if (!result.externalPositions?.defaultBlocks || !result.externalPositions.saved || !result.externalPositions.restored) throw new Error('NATIVE_EXTERNAL_POSITION_POLICY_NOT_VERIFIED');
if(!['restored','localTarget','exchangeValue','summaryVisible','detailsCollapsed','contractLimits','manualPosition','orderCounts','makerDefault','makerRestored'].every(key=>result.settingsRoundTrip?.[key]===true))throw new Error('NATIVE_FUTURES_SETTINGS_NOT_VERIFIED');
if(!["perOrder","roundTrip","fees","funding","longLeg","shortLeg","estimatedExitSeparate","unknownNotZero"].every(key=>result.tradeReporting?.[key]===true))throw new Error('NATIVE_TRADE_REPORT_NOT_VERIFIED');
if(!result.passed||result.version!=='0.4.1-customer'||!result.assetModes?.multi||!result.assetModes?.single||!result.assetModes?.cross||!result.twoWorkspaces||!result.legs.closeLong||!result.legs.closeShort||!result.margin.manualEnabled||!result.margin.autoDisabled||!result.unconfiguredStartBlocked||!result.unlicensedStartBlocked||!result.customerSubscriptionIntegrated||result.realAccountReads!==0||result.exchangeOrders!==0)throw new Error('NATIVE_WORKBENCH_RESULT_INCOMPLETE');
console.log(JSON.stringify(result));
