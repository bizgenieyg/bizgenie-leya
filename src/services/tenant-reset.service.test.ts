import assert from 'node:assert/strict';
import test from 'node:test';
import type {DatabaseClient} from '../db/supabase.js';
import {HttpError} from '../utils/http-error.js';
import {resetTenantCustomerDataAfterNumberChange,type NumberChangeResetGuard} from './tenant-reset.service.js';

const tenantId='123e4567-e89b-42d3-a456-426614174000';

function fixture(pending:boolean){
 const calls:string[]=[];
 const db={rpc:async()=>{calls.push('reset');return{error:null};}} as unknown as DatabaseClient;
 const guard:NumberChangeResetGuard={
  requirePendingNumberChange:async()=>{calls.push('guard');if(!pending)throw new HttpError(409,'No pending WhatsApp number change');},
  acknowledgeNumberChange:async()=>{calls.push('ack');},
 };
 return{calls,db,guard};
}

test('tenant reset is rejected before deletion when no number change is pending',async()=>{
 const h=fixture(false);
 await assert.rejects(resetTenantCustomerDataAfterNumberChange(h.db,h.guard,tenantId),
  (error:unknown)=>error instanceof HttpError&&error.status===409);
 assert.deepEqual(h.calls,['guard']);
});

test('tenant reset runs once behind the pending guard and consumes the number change',async()=>{
 const h=fixture(true);
 await resetTenantCustomerDataAfterNumberChange(h.db,h.guard,tenantId);
 assert.deepEqual(h.calls,['guard','reset','ack']);
});
