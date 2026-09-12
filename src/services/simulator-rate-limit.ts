import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {ALERT_LOCK_STALE_MS,SIMULATOR_LIMIT_STATE_DIR} from '../config/behavior.js';

type State={hour:string;hourCount:number;day:string;dayCount:number};
export type SimulatorReservation={allowed:boolean;period?:'hour'|'day'};

/** Durable single-VPS counter with a per-tenant lock, separate from customer usage. */
export async function reserveSimulatorCall(tenantId:string,hourlyLimit:number,dailyLimit:number,now=new Date(),root=SIMULATOR_LIMIT_STATE_DIR):Promise<SimulatorReservation>{
 const key=createHash('sha256').update(tenantId).digest('hex'),lock=join(root,key+'.lock'),statePath=join(root,key+'.json');
 await mkdir(root,{recursive:true});
 for(let attempt=0;attempt<3;attempt++){
  try{await mkdir(lock);break;}catch{
   try{if(now.getTime()-(await stat(lock)).mtimeMs>ALERT_LOCK_STALE_MS)await rm(lock,{recursive:true,force:true});}catch{}
   if(attempt===2)return{allowed:false,period:'hour'};
   await new Promise(resolve=>setTimeout(resolve,10*(attempt+1)));
  }
 }
 try{
  const hour=now.toISOString().slice(0,13),day=now.toISOString().slice(0,10);let state:State={hour,hourCount:0,day,dayCount:0};
  try{const parsed=JSON.parse(await readFile(statePath,'utf8')) as Partial<State>;state={hour,day,hourCount:parsed.hour===hour?Number(parsed.hourCount)||0:0,dayCount:parsed.day===day?Number(parsed.dayCount)||0:0};}catch{}
  if(state.dayCount>=dailyLimit)return{allowed:false,period:'day'};
  if(state.hourCount>=hourlyLimit)return{allowed:false,period:'hour'};
  state.hourCount++;state.dayCount++;
  const temporary=statePath+'.tmp';await writeFile(temporary,JSON.stringify(state),{mode:0o600});await rename(temporary,statePath);return{allowed:true};
 }finally{await rm(lock,{recursive:true,force:true});}
}
