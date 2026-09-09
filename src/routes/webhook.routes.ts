import { handleVoiceUsage,voiceUsage } from "../services/voice-usage.service.js";
import { createWhatsAppProvider } from "../providers/whatsapp/index.js";
import { filterIncoming, logRejectedIncoming } from "../utils/incoming-policy.js";
import { webhookFailureDetails } from "../utils/webhook-error.js";
import { webhookAuthValid } from "../utils/webhook-auth.js";
import { Router } from "express";

import { requireEnv } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { getTenantRouting } from "../services/tenant.service.js";
import { decryptCredential } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody } from "../utils/validation.js";
import { handleWebhookEvent } from "../workers/webhook.worker.js";
import { observeOwnerOutgoing } from '../services/outgoing-owner.service.js';

export const webhookRouter = Router();

// POST /webhook/:tenantId
webhookRouter.post("/:tenantId", async (request, response) => {
  const tenantId = request.params.tenantId;

  const routing = await getTenantRouting(supabase, tenantId);
  if (!routing || !routing.instance?.webhook_secret_encrypted) {
    // Unknown tenant, or no configured secret to verify against.
    throw new HttpError(401, "Unauthorized webhook");
  }

  const secret = decryptCredential(
    routing.instance.webhook_secret_encrypted,
    requireEnv("CREDENTIAL_ENCRYPTION_KEY"),
  );
  if (!webhookAuthValid(request, secret)) {
    throw new HttpError(401, "Unauthorized webhook");
  }

  const body = objectBody(request.body);

  // Acknowledge fast; do the resolve/answer/escalate work off the request path.
  response.status(200).json({ received: true });

  const decision = filterIncoming(body);
  if (!decision.allowed) {
    logRejectedIncoming(decision);
    if(decision.reason==='outgoing_message')setImmediate(()=>{observeOwnerOutgoing(supabase,tenantId,body).catch(error=>console.error('owner_outgoing_observation_failed',{tenantId,errorType:error instanceof Error?error.name:'UnknownError'}));});
    if(voiceUsage(body)) setImmediate(()=>{handleVoiceUsage(supabase,routing,body,createWhatsAppProvider()).catch(()=>console.error('voice_usage_handler_failed'));});
    return;
  }

  setImmediate(() => {
    handleWebhookEvent(tenantId, body).catch((error) => {
      console.error(
        "webhook worker failed:",
        { tenantId, ...webhookFailureDetails(error, body) },
      );
    });
  });
});
