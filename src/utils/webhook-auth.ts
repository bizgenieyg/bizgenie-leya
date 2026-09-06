import type { Request } from "express";
import { hmacHex, secretsMatch, timingEqual } from "./crypto.js";

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
export function webhookAuthValid(request: Request, secret: string): boolean {
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
