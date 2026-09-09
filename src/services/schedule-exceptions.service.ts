import type { DatabaseClient } from '../db/supabase.js';
import { HttpError } from '../utils/http-error.js';

const date=(value:unknown)=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value+'T00:00:00Z'));
const time=(value:unknown)=>typeof value==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(value);
const uuid=(value:unknown)=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function validateException(input:Record<string,unknown>){
  if(!date(input.start_date)||!date(input.end_date)||String(input.end_date)<String(input.start_date))throw new HttpError(400,'Invalid exception dates');
  if(!['day_off','special_hours'].includes(String(input.kind)))throw new HttpError(400,'Invalid exception kind');
  if(typeof input.name!=='string'||!input.name.trim()||input.name.trim().length>120)throw new HttpError(400,'Invalid exception name');
  if(typeof input.recurs_annually!=='boolean')throw new HttpError(400,'Invalid recurrence');
  const special=input.kind==='special_hours';
  if(special&&(!time(input.work_start)||!time(input.work_end)||input.work_start===input.work_end))throw new HttpError(400,'Invalid special hours');
  return {start_date:input.start_date,end_date:input.end_date,kind:input.kind,
    work_start:special?input.work_start:null,work_end:special?input.work_end:null,
    name:input.name.trim(),recurs_annually:input.recurs_annually};
}
export async function listExceptions(db:DatabaseClient,tenantId:string){
  const {data,error}=await db.from('schedule_exceptions').select('id,start_date,end_date,kind,work_start,work_end,name,recurs_annually').eq('tenant_id',tenantId).order('start_date');
  if(error)throw new Error('Schedule exceptions unavailable');return data??[];
}
export async function createException(db:DatabaseClient,tenantId:string,input:Record<string,unknown>){
  const {data,error}=await db.from('schedule_exceptions').insert({tenant_id:tenantId,...validateException(input)}).select('id,start_date,end_date,kind,work_start,work_end,name,recurs_annually').single();
  if(error)throw new Error('Schedule exception create failed');return data;
}
export async function updateException(db:DatabaseClient,tenantId:string,id:unknown,input:Record<string,unknown>){
  if(!uuid(id))throw new HttpError(400,'Invalid exception id');
  const {data,error}=await db.from('schedule_exceptions').update({...validateException(input),updated_at:new Date().toISOString()}).eq('tenant_id',tenantId).eq('id',id).select('id,start_date,end_date,kind,work_start,work_end,name,recurs_annually').maybeSingle();
  if(error)throw new Error('Schedule exception update failed');if(!data)throw new HttpError(404,'Exception not found');return data;
}
export async function deleteException(db:DatabaseClient,tenantId:string,id:unknown){
  if(!uuid(id))throw new HttpError(400,'Invalid exception id');
  const {data,error}=await db.from('schedule_exceptions').delete().eq('tenant_id',tenantId).eq('id',id).select('id');
  if(error)throw new Error('Schedule exception delete failed');if(!data?.length)throw new HttpError(404,'Exception not found');
}
