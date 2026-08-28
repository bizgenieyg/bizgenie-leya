import { Router } from "express";
import type { Request } from "express";

import { requireEnv } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { getTenantRouting } from "../services/tenant.service.js";
import { decryptCredential, hmacHex, secretsMatch, timingEqual } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody } from "../utils/validation.js";
import { handleWebhookEvent } from "../workers/webhook.worker.js";

export const webhookRouter = Router();

/** Raw request bytes captured by the JSON body parser's `verify` hook (see server.ts). */
function rawBodyOf(request: Request): Buffer | undefined {
  return (request as Request & { rawBody?: Buffer }).rawBody;
}

/**
 * Verify the request actually came from this tenant's WAHA instance.
 *
 * Primary: `X-Hub-Signature-256` HMAC over the raw body, keyed with the tenant's
 * webhook secret. Fallback: a shared-secret `X-Webhook-Token` header.
 */
function webhookAuthValid(request: Request, secret: string): boolean {
  const signature = request.header("x-hub-signature-256");
  if (signature) {
    const raw = rawBodyOf(request);
    if (!raw) {
      return false;
    }
    const provided = signature.startsWith("sha256=") ? signature.slice(7) : signature;
    return timingEqual(provided, hmacHex(secret, raw));
  }

  const token = request.header("x-webhook-token");
  if (token) {
    return secretsMatch(token, secret);
  }

  return false;
}

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

  setImmediate(() => {
    handleWebhookEvent(tenantId, body).catch((error) => {
      console.error(
        "webhook worker failed:",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  });
});
