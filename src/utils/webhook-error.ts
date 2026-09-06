import { randomUUID } from "node:crypto";
import { webhookEventType } from "./webhook-message.js";

/** Preserve call sites, excluding the error message which may contain payloads/credentials. */
export function webhookFailureDetails(error: unknown, body: Record<string, unknown>) {
  const errorType = error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "UnknownError";
  const frames = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(error.message.split("\n").length)
        .filter(line => /^\s+at /.test(line))
    : [];
  // WAHA envelope id is a ULID; never substitute payload.id or message text.
  const wahaId = typeof body.id === "string" && /^[0-9a-hjkmnp-tv-z]{26}$/i.test(body.id) ? body.id : null;
  return { level: "error", eventId: wahaId ?? randomUUID(),
    eventIdSource: wahaId ? "waha" : "generated", event: webhookEventType(body), errorType, stack: [errorType, ...frames].join("\n") };
}
