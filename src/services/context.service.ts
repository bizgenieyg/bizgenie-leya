import type { DatabaseClient } from "../db/supabase.js";

import { HttpError } from "../utils/http-error.js";
import type { KnowledgeCandidate } from "./knowledge.service.js";

export interface AssistantContext {
  assistant_name: string | null;
  allowed_languages: string[] | null;
  tone: string | null;
  mode: string | null;
  system_rules: string | null;
}

export interface TenantContext {
  assistant: AssistantContext | null;
  knowledge: KnowledgeCandidate[];
}

export interface ConversationMemory { fromMe:boolean; text:string; createdAt:string; }
export async function loadConversationMemory(db:DatabaseClient,tenantId:string,conversationId:string,count:number,retentionHours:number):Promise<{messages:ConversationMemory[];introduced:boolean}>{
  const cutoff=new Date(Date.now()-retentionHours*3600000).toISOString();
  const cleanup=await db.from('messages').delete().eq('tenant_id',tenantId).eq('conversation_id',conversationId).lt('created_at',cutoff);
  if(cleanup.error)console.error('conversation_context_cleanup_failed',{tenantId,conversationId});
  const [history,conversation]=await Promise.all([
    db.from('messages').select('from_me,body,created_at').eq('tenant_id',tenantId).eq('conversation_id',conversationId).eq('msg_type','text').gte('created_at',cutoff).order('created_at',{ascending:false}).limit(count),
    db.from('conversations').select('assistant_introduced_at').eq('tenant_id',tenantId).eq('id',conversationId).maybeSingle(),
  ]);
  if(history.error||conversation.error)throw new HttpError(500,'Could not load conversation memory');
  return {messages:(history.data??[]).reverse().filter(row=>typeof row.body==='string').map(row=>({fromMe:row.from_me===true,text:row.body as string,createdAt:row.created_at as string})),introduced:!!conversation.data?.assistant_introduced_at};
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
      .select("assistant_name, allowed_languages, tone, mode, system_rules")
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
