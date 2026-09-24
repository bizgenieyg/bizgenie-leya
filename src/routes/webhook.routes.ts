import { voiceUsage } from "../services/voice-usage.service.js";
import { filterIncoming, ownerIdentityField, readSessionIdentity } from "../utils/incoming-policy.js";
import { webhookAuthValid } from "../utils/webhook-auth.js";
import { Router } from "express";

import { requireEnv } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { getTenantRouting } from "../services/tenant.service.js";
import { isBusinessOwner, loadOwnerSettings } from '../services/owner-settings.service.js';
import { behavior } from '../services/runtime-settings.service.js';
import { decryptCredential } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody } from "../utils/validation.js";
import { enqueueInbound } from '../workers/inbound-queue.js';

export const webhookRouter = Router();
const limits = new Map<string, { count: number; expiresAt: number }>();
function checkWebhookRate(ip: string): void {
  const now = Date.now();
  const current = limits.get(ip);
  const next = !current || current.expiresAt <= now ? { count: 1, expiresAt: now + 60_000 } : { ...current, count: current.count + 1 };
  limits.set(ip, next);
  if (next.count > 120) throw new HttpError(429, 'Webhook rate limited');
  if (limits.size > 10_000) for (const [key, value] of limits) if (value.expiresAt <= now) limits.delete(key);
}

// POST /webhook/:tenantId
webhookRouter.post("/:tenantId", async (request, response) => {
  checkWebhookRate(request.ip ?? 'unknown');
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

  const decision = filterIncoming(body);
  let quietSeconds = 0;
  if (decision.allowed || voiceUsage(body)) {
    const settings = await loadOwnerSettings(supabase, tenantId);
    const message = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload) ? body.payload as Record<string, unknown> : {};
    const from = typeof message.from === 'string' ? message.from : '';
    const owner = isBusinessOwner(from, settings) || !!ownerIdentityField(from, readSessionIdentity(body.me)) ||
      (from.endsWith('@lid') && !!settings.owner_pairing_hash && /^\D*\d{6}\D*$/.test(String(message.body ?? '')));
    quietSeconds = owner ? 0 : behavior(settings).inbound_quiet_seconds;
  }
  await enqueueInbound(supabase, tenantId, body, quietSeconds);
  response.status(200).json({ received: true });
});
