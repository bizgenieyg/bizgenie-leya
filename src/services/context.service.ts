import type { DatabaseClient } from "../db/supabase.js";

import { HttpError } from "../utils/http-error.js";
import type { KnowledgeCandidate } from "./knowledge.service.js";

export interface AssistantContext {
  assistant_name: string | null;
  tone: string | null;
  mode: string | null;
  system_rules: string | null;
}

export interface TenantContext {
  assistant: AssistantContext | null;
  knowledge: KnowledgeCandidate[];
}

/**
 * Load the minimal context the Knowledge Module needs for a tenant:
 * the assistant profile and every active FAQ item that has a question.
 */
export async function loadContext(
  db: DatabaseClient,
  tenantId: string,
): Promise<TenantContext> {
  const [assistantResult, knowledgeResult] = await Promise.all([
    db
      .from("assistant_profiles")
      .select("assistant_name, tone, mode, system_rules")
      .eq("tenant_id", tenantId)
      .maybeSingle(),
    db
      .from("knowledge_items")
      .select("id, question, answer")
      .eq("tenant_id", tenantId)
      .eq("type", "faq")
      .eq("active", true)
      .not("question", "is", null),
  ]);

  if (assistantResult.error) {
    throw new HttpError(500, "Could not load assistant profile");
  }
  if (knowledgeResult.error) {
    throw new HttpError(500, "Could not load knowledge items");
  }

  const knowledge: KnowledgeCandidate[] = (knowledgeResult.data ?? []).map(
    (item) => ({
      id: item.id as string,
      question: item.question as string | null,
      answer: item.answer as string,
    }),
  );

  return {
    assistant: (assistantResult.data as AssistantContext | null) ?? null,
    knowledge,
  };
}
