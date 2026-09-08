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
  response.json({timeZone:settings.time_zone??'UTC',phone:settings.owner_phone??'',quietStart:settings.quiet_hours_start?.slice(0,5)??'',quietEnd:settings.quiet_hours_end?.slice(0,5)??'',paired:!!settings.owner_chat_id});
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
  const messages=body.messagesPerMonth,voice=body.voiceMinutesPerMonth;
  if(!Number.isSafeInteger(messages)||Number(messages)<0||Number(messages)>2147483647||!Number.isSafeInteger(voice)||Number(voice)<0||Number(voice)>2147483647)throw new HttpError(400,'Limits must be non-negative integers');
  const {error}=await supabase.from('tenant_usage_limits').upsert({tenant_id:tenantId,messages_per_month:messages,voice_minutes_per_month:voice,updated_at:new Date().toISOString()},{onConflict:'tenant_id'});
  if(error)throw new HttpError(500,'Could not save usage limits');
  response.json({updated:true});
});
