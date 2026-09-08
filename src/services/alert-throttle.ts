import { mkdir,readFile,writeFile,rm,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { ALERT_STATE_DIR,ALERT_LOCK_STALE_MS } from '../config/behavior.js';
/** Single-VPS durable throttle, independent of the metering database and PM2 restarts. */
export async function reserveFailureAlert(tenantId:string,intervalMs:number,now:number,root=ALERT_STATE_DIR):Promise<boolean>{
 const key=createHash('sha256').update(tenantId).digest('hex'),lock=join(root,key+'.lock'),state=join(root,key+'.json');
 await mkdir(root,{recursive:true});
 try{await mkdir(lock);}catch{
  try{if(now-(await stat(lock)).mtimeMs>ALERT_LOCK_STALE_MS)await rm(lock,{recursive:true,force:true});}catch{}
  return false;
 }
 try{
  let previous=-Infinity;try{previous=Number(JSON.parse(await readFile(state,'utf8')).at);}catch{}
  if(now-previous<intervalMs)return false;
  await writeFile(state,JSON.stringify({at:now}),{mode:0o600});return true;
 }finally{await rm(lock,{recursive:true,force:true});}
}
