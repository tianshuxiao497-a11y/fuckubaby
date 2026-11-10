// Run the actual native packaged desktop in its isolated offline self-test mode.
import {spawn} from 'node:child_process';
import {resolve} from 'node:path';
import {readFile,mkdir} from 'node:fs/promises';
const [executable,output]=process.argv.slice(2);if(!executable||!output)throw new Error('native_executable_and_output_required');
const destination=resolve(output);await mkdir(destination,{recursive:true});
const child=spawn(resolve(executable),['--self-test='+destination],{env:{...process.env,ELECTRON_ENABLE_LOGGING:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let stderr='',stdout='';child.stderr.on('data',d=>{stderr=(stderr+d).slice(-8000);});child.stdout.on('data',d=>{stdout=(stdout+d).slice(-8000);});
const timeout=setTimeout(()=>child.kill('SIGTERM'),60000);
const code=await new Promise((done,reject)=>{child.on('error',reject);child.on('close',done);});clearTimeout(timeout);
if(code!==0){console.error(stderr.slice(-3000));throw new Error('native_self_test_failed_'+code);}
const result=JSON.parse(await readFile(resolve(destination,'RESULT.json'),'utf8'));if(!result.passed||result.exchangeOrders!==0||!result.bundledControllerBooted)throw new Error('native_result_incomplete');
console.log(JSON.stringify(result));
