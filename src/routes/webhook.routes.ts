import { webhookAuthValid } from "../utils/webhook-auth.js";
import { Router } from "express";

import { requireEnv } from "../config/env.js";
import { supabase } from "../db/supabase.js";
import { getTenantRouting } from "../services/tenant.service.js";
import { decryptCredential } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody } from "../utils/validation.js";
import { handleWebhookEvent } from "../workers/webhook.worker.js";

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

  setImmediate(() => {
    handleWebhookEvent(tenantId, body).catch((error) => {
      console.error(
        "webhook worker failed:",
        error instanceof Error ? error.message : "unknown error",
      );
    });
  });
});
