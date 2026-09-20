import type { DatabaseClient } from '../db/supabase.js';

/**
 * Destructive, owner-triggered reset of one tenant's customer data — used when the
 * business switches its WhatsApp number and wants the cabinet to start clean. Deletes
 * clients, conversations, messages, escalations, agent actions and owner-summary jobs
 * for the tenant via a single SECURITY INVOKER SQL function (dependency order handled
 * there, in one transaction). Deliberately leaves tenant settings/schedule/knowledge
 * untouched — none of it is tied to a specific WhatsApp number.
 */
export async function resetTenantCustomerData(db: DatabaseClient, tenantId: string): Promise<void> {
  const { error } = await db.rpc('reset_tenant_customer_data', { p_tenant_id: tenantId });
  if (error) throw new Error('Tenant data reset failed');
}

export interface NumberChangeResetGuard {
  requirePendingNumberChange(tenantId:string):Promise<void>;
  acknowledgeNumberChange(tenantId:string):Promise<void>;
}

export async function resetTenantCustomerDataAfterNumberChange(db:DatabaseClient,guard:NumberChangeResetGuard,tenantId:string):Promise<void>{
  await guard.requirePendingNumberChange(tenantId);
  await resetTenantCustomerData(db,tenantId);
  await guard.acknowledgeNumberChange(tenantId);
}
