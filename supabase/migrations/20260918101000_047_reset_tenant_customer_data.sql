begin;

-- Owner-triggered "reset cabinet data" action (e.g. after switching the business to a
-- different WhatsApp number): wipes one tenant's customer data in the FK-safe order,
-- in a single transaction. Deliberately does not touch tenant settings/schedule/time
-- zone (notification_settings) or the knowledge base (knowledge_items/knowledge_documents/
-- knowledge_chunks) — none of that is tied to a specific WhatsApp number.
--
-- scheduled_jobs is scoped to owner_summary and owner_escalation rows only: those
-- reference the escalations/clients being deleted here and would otherwise sit as dead
-- pending rows forever (see owner-workflow.service.ts:runDueScheduledEscalations, which
-- silently skips a job whose escalation id no longer exists). usage_limit_notice and
-- weekly_report rows are billing/report scheduling, not client data, and are left alone.
create or replace function public.reset_tenant_customer_data(p_tenant_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $function$
begin
  delete from public.messages where tenant_id = p_tenant_id;
  delete from public.escalations where tenant_id = p_tenant_id;
  delete from public.agent_actions where tenant_id = p_tenant_id;
  delete from public.scheduled_jobs where tenant_id = p_tenant_id and job_type in ('owner_summary','owner_escalation');
  delete from public.client_profiles where tenant_id = p_tenant_id;
  delete from public.conversations where tenant_id = p_tenant_id;
  delete from public.clients where tenant_id = p_tenant_id;
end;
$function$;

revoke all on function public.reset_tenant_customer_data(uuid) from public, anon, authenticated;
grant execute on function public.reset_tenant_customer_data(uuid) to service_role;

commit;
