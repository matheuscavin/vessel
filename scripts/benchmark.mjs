// End-to-end daemon byte throughput, no browser renderer. Run after cargo build --release -p vessel-core.
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
const dir=await mkdtemp(join(tmpdir(),'vessel-bench-'));
const child=spawn('target/release/vessel-daemon',[],{env:{...process.env,VESSEL_DATA_DIR:dir}});
let ep;
async function rpc(request){return new Promise((resolve,reject)=>{const s=net.connect(ep.port,'127.0.0.1');let result=Buffer.alloc(0);s.on('error',reject);s.on('connect',()=>{const data=Buffer.from(JSON.stringify({token:ep.token,request}));const size=Buffer.alloc(4);size.writeUInt32BE(data.length);s.write(Buffer.concat([size,data]));});s.on('data',chunk=>{result=Buffer.concat([result,chunk]);if(result.length>=5&&result.length>=5+result.readUInt32BE(1)){s.end();if(result[0])reject(Error(result.subarray(5).toString()));else resolve(request.op==='read'?result.subarray(5):JSON.parse(result.subarray(5).toString()));}});});}
try{
 for(let i=0;i<100;i++){try{ep=JSON.parse(await readFile(join(dir,'endpoint.json'),'utf8'));break;}catch{await new Promise(r=>setTimeout(r,50));}}
 const w=await rpc({op:'createWorkspace',name:'Benchmark'});const s=await rpc({op:'createSession',workspaceId:w.state.selectedWorkspace,name:'Throughput',path:dir});const t=await rpc({op:'createTerminal',sessionId:s.state.selectedSession,launch:false});const id=t.state.selectedTerminal;
 const size=16*1024*1024;const start=performance.now();await rpc({op:'startProcess',id,program:'/bin/sh',args:['-c',`sleep 0.05; yes 'vessel benchmark: building packages, checking types, running tests' | head -c ${size}`]});let cursor=0,received=0,resets=0;
 while(true){const frame=await rpc({op:'read',id,cursor,readerId:'benchmark'});cursor=Number(frame.readBigUInt64BE());received+=frame.length-10;resets+=frame[8];if(frame[9])break;}
 const seconds=(performance.now()-start)/1000;console.log(JSON.stringify({sourceMiB:16,seconds:+seconds.toFixed(3),sourceMiBPerSecond:+(16/seconds).toFixed(2),receivedBytes:received,resets,boundedRingMiB:1},null,2));await rpc({op:'closeTerminal',id});
}finally{child.kill();await rm(dir,{recursive:true,force:true});}
