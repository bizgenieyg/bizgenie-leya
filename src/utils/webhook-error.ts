import { webhookEventType } from "./webhook-message.js";

/** Preserve call sites, excluding the error message which may contain payloads/credentials. */
export function webhookFailureDetails(error: unknown, body: Record<string, unknown>) {
  const errorType = error instanceof TypeError ? "TypeError" : error instanceof Error ? "Error" : "UnknownError";
  const frames = error instanceof Error && typeof error.stack === "string"
    ? error.stack.split("\n").slice(error.message.split("\n").length)
        .filter(line => /^\s+at /.test(line)).slice(0, 20)
    : [];
  return { event: webhookEventType(body), errorType, stack: [errorType, ...frames].join("\n") };
}
