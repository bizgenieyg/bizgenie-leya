import { readRuntimeSettings,saveRuntimeSettings } from '../services/runtime-settings.service.js';
import { createException,deleteException,listExceptions,updateException } from '../services/schedule-exceptions.service.js';
import { registry } from '../agents/index.js';
import { usageSummary } from "../services/usage.service.js";
import { supabase } from '../db/supabase.js';
import { loadOwnerSettings, saveOwnerSettings } from '../services/owner-settings.service.js';
import { getTenantRouting } from '../services/tenant.service.js';
import { createWhatsAppProvider } from '../providers/whatsapp/index.js';
import { readSessionIdentity } from '../utils/incoming-policy.js';
import { Router } from "express";

import { WahaAdminService } from "../services/waha-admin.service.js";
import { isUuid } from "../services/tenant.service.js";
import { requireAdmin } from "../utils/admin-auth.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody, requiredString } from "../utils/validation.js";
import { DEFAULT_TIME_ZONE } from '../config/time-zones.js';
import { deleteClientCard,getClientCard,listClientCards,updateClientCard } from '../services/client-cards.service.js';
import { buildOwnerSummary } from '../services/owner-summary.service.js';
import { simulateCustomerMessage } from '../services/simulator.service.js';

const waha = new WahaAdminService();

export const adminRouter = Router();
adminRouter.use(requireAdmin);

function queryTenantId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new HttpError(400, "tenantId must be a UUID");
  }
  return value;
}

adminRouter.post("/waha/create", async (request, response) => {
  const tenantId = requiredString(objectBody(request.body), "tenantId");
  if (!isUuid(tenantId)) throw new HttpError(400, "tenantId must be a UUID");
  const result = await waha.create(tenantId);
  response.status(result.created ? 201 : 200).json(result);
});

adminRouter.get("/waha/qr", async (request, response) => {
  const qr = await waha.qr(queryTenantId(request.query.tenantId));
  response.setHeader("Content-Type", qr.contentType);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(qr.data);
});

adminRouter.get("/waha/status", async (request, response) => {
  response.json(await waha.status(queryTenantId(request.query.tenantId)));
});

adminRouter.post("/waha/reconnect", async (request, response) => {
  response.json(await waha.reconnect(queryTenantId(request.query.tenantId)));
});

adminRouter.post("/waha/disconnect", async (request, response) => {
  response.json(await waha.disconnect(queryTenantId(request.query.tenantId)));
});

// Tenant selection and owner/admin authorization are performed by the Next.js proxy.
adminRouter.get('/owner-settings', async (request,response) => {
  const settings=await loadOwnerSettings(supabase,queryTenantId(request.query.tenantId));
  response.setHeader('Cache-Control','no-store');
  response.json({timeZone:settings.time_zone??DEFAULT_TIME_ZONE,phone:settings.owner_phone??'',quietStart:settings.quiet_hours_start?.slice(0,5)??'',quietEnd:settings.quiet_hours_end?.slice(0,5)??'',paired:!!settings.owner_chat_id});
});
adminRouter.post('/owner-settings', async (request,response) => {
  const tenantId=queryTenantId(request.query.tenantId);
  const routing=await getTenantRouting(supabase,tenantId);
  if(!routing?.instance?.session_name) throw new HttpError(409,'Сначала подключите бизнес-номер WhatsApp.');
  const status=await createWhatsAppProvider().getSessionStatus(routing.instance.session_name);
  if(status.status!=='WORKING') throw new HttpError(409,'Сначала подключите бизнес-номер WhatsApp.');
  response.setHeader('Cache-Control','no-store');
  response.json(await saveOwnerSettings(supabase,tenantId,objectBody(request.body),readSessionIdentity(status.me)));
});


adminRouter.get('/usage',async(request,response)=>{
  const tenantId=queryTenantId(request.query.tenantId);
  response.setHeader('Cache-Control','no-store');
  response.json(await usageSummary(supabase,tenantId));
});
adminRouter.patch('/usage-limits',async(request,response)=>{
  const tenantId=queryTenantId(request.query.tenantId),body=objectBody(request.body);
  const messages=body.messagesPerMonth,voice=body.voiceMinutesPerMonth,warning=body.warningPercent,plan=body.plan,usePlanDefaults=body.usePlanDefaults===true;
  if(typeof plan!=='string'||!plan.trim()||plan.length>50||!usePlanDefaults&&(!Number.isSafeInteger(messages)||Number(messages)<0||Number(messages)>2147483647||!Number.isSafeInteger(voice)||Number(voice)<0||Number(voice)>2147483647||!Number.isSafeInteger(warning)||Number(warning)<1||Number(warning)>100))throw new HttpError(400,'Invalid system tariff settings');
  const planCode=plan.trim();
  const configured=await supabase.from('plans').select('code,messages_per_month,voice_minutes_per_month,warning_percent').eq('code',planCode).maybeSingle();
  if(configured.error||!configured.data)throw new HttpError(400,'Unknown plan');
  const {error}=await supabase.from('tenant_usage_limits').upsert({tenant_id:tenantId,messages_per_month:usePlanDefaults?configured.data.messages_per_month:messages,voice_minutes_per_month:usePlanDefaults?configured.data.voice_minutes_per_month:voice,warning_percent:usePlanDefaults?configured.data.warning_percent:warning,plan:planCode,messages_overridden:!usePlanDefaults,voice_overridden:!usePlanDefaults,warning_overridden:!usePlanDefaults,updated_at:new Date().toISOString()},{onConflict:'tenant_id'});
  if(error)throw new HttpError(500,'Could not save usage limits');
  response.json({updated:true});
});
adminRouter.get('/plans',async(_request,response)=>{
  const {data,error}=await supabase.from('plans').select('code,display_name,messages_per_month,voice_minutes_per_month,warning_percent,unlimited').order('code');
  if(error)throw new HttpError(500,'Could not load plans');response.json(data??[]);
});
adminRouter.put('/plans/:code',async(request,response)=>{
  const code=String(request.params.code),body=objectBody(request.body);
  const name=body.displayName,messages=body.messagesPerMonth,voice=body.voiceMinutesPerMonth,warning=body.warningPercent,unlimited=body.unlimited??false;
  if(!/^[a-z][a-z0-9_-]{0,49}$/.test(code)||typeof name!=='string'||!name.trim()||name.length>100||typeof unlimited!=='boolean'||!Number.isSafeInteger(messages)||Number(messages)<0||!Number.isSafeInteger(voice)||Number(voice)<0||!Number.isSafeInteger(warning)||Number(warning)<1||Number(warning)>100)throw new HttpError(400,'Invalid plan');
  const {error}=await supabase.from('plans').upsert({code,display_name:name.trim(),messages_per_month:messages,voice_minutes_per_month:voice,warning_percent:warning,unlimited,updated_at:new Date().toISOString()});
  if(error)throw new HttpError(500,'Could not save plan');response.json({updated:true});
});

adminRouter.get('/schedule-exceptions',async(request,response)=>response.json(await listExceptions(supabase,queryTenantId(request.query.tenantId))));
adminRouter.post('/schedule-exceptions',async(request,response)=>response.status(201).json(await createException(supabase,queryTenantId(request.query.tenantId),objectBody(request.body))));
adminRouter.patch('/schedule-exceptions',async(request,response)=>response.json(await updateException(supabase,queryTenantId(request.query.tenantId),request.query.id,objectBody(request.body))));
adminRouter.delete('/schedule-exceptions',async(request,response)=>{await deleteException(supabase,queryTenantId(request.query.tenantId),request.query.id);response.status(204).send();});

adminRouter.get('/tenant-settings',async(request,response)=>{
 response.setHeader('Cache-Control','no-store');response.json(await readRuntimeSettings(supabase,queryTenantId(request.query.tenantId)));
});
adminRouter.get('/clients',async(request,response)=>{response.setHeader('Cache-Control','no-store');response.json(await listClientCards(supabase,queryTenantId(request.query.tenantId),typeof request.query.search==='string'?request.query.search:''));});
adminRouter.get('/clients/:id',async(request,response)=>{response.setHeader('Cache-Control','no-store');response.json(await getClientCard(supabase,queryTenantId(request.query.tenantId),String(request.params.id)));});
adminRouter.patch('/clients/:id',async(request,response)=>response.json(await updateClientCard(supabase,queryTenantId(request.query.tenantId),String(request.params.id),objectBody(request.body))));
adminRouter.delete('/clients/:id',async(request,response)=>{await deleteClientCard(supabase,queryTenantId(request.query.tenantId),String(request.params.id),request.query.permanent==='true');response.status(204).send();});
adminRouter.get('/owner-summary',async(request,response)=>{const tenantId=queryTenantId(request.query.tenantId),to=request.query.to?new Date(String(request.query.to)):new Date(),from=request.query.from?new Date(String(request.query.from)):new Date(to.getTime()-7*86400000);if(!Number.isFinite(from.getTime())||!Number.isFinite(to.getTime())||from>=to||to.getTime()-from.getTime()>366*86400000)throw new HttpError(400,'Invalid summary period');response.setHeader('Cache-Control','no-store');response.json(await buildOwnerSummary(supabase,tenantId,from,to));});
adminRouter.post('/simulator',async(request,response)=>{const tenantId=queryTenantId(request.query.tenantId),text=requiredString(objectBody(request.body),'text').trim();if(!text||text.length>2000)throw new HttpError(400,'Message must contain 1 to 2000 characters');response.setHeader('Cache-Control','no-store');response.json(await simulateCustomerMessage(supabase,tenantId,text));});
// This endpoint is reachable only with ADMIN_SECRET (requireAdmin). There is no separate
// operator credential, so a `?scope=operator` flag would be security theatre — anyone
// holding ADMIN_SECRET could add it. The real tenant-facing boundary is the Next.js proxy,
// which only forwards the owner-editable field set; operator-only fields (templates,
// escalation timings, retention, routing, …) can be changed solely by a caller that holds
// ADMIN_SECRET directly, exactly like PATCH /usage-limits. validateRuntimePatch still
// rejects billing/system fields here unconditionally.
adminRouter.patch('/tenant-settings',async(request,response)=>{
 const input=objectBody(request.body);
 if(Array.isArray(input.enabled_agents)&&input.enabled_agents.some(name=>!registry.list().some(a=>a.name===name)))throw new HttpError(400,'Unknown agent');
 response.json(await saveRuntimeSettings(supabase,queryTenantId(request.query.tenantId),input));
});
