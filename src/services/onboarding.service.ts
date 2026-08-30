import { requireEnv } from "../config/env.js";
import { supabase, type DatabaseClient } from "../db/supabase.js";
import { createSetupToken, encryptCredential, hashSetupToken } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";
import { findExactKnowledgeAnswer } from "./knowledge.service.js";

const SETUP_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

type JsonObject = Record<string, unknown>;

function databaseError(context: string, _error: { message: string } | null): never {
  throw new HttpError(500, context);
}

export class OnboardingService {
  constructor(private readonly db: DatabaseClient = supabase) {}

  async createTenant(input: { name: string; phone: string; businessName?: string | null }) {
    const token = createSetupToken();
    const expiresAt = new Date(Date.now() + SETUP_LIFETIME_MS).toISOString();
    const { data: tenant, error: tenantError } = await this.db
      .from("tenants")
      .insert({
        name: input.name,
        phone: input.phone,
        business_name: input.businessName,
        status: "draft",
      })
      .select("id")
      .single();
    if (tenantError || !tenant) databaseError("Could not create tenant", tenantError);

    const { error: sessionError } = await this.db.from("onboarding_sessions").insert({
      tenant_id: tenant.id,
      setup_token_hash: hashSetupToken(token),
      status: "draft",
      expires_at: expiresAt,
    });
    if (sessionError) {
      await this.db.from("tenants").delete().eq("id", tenant.id);
      databaseError("Could not create onboarding session", sessionError);
    }

    return { tenantId: tenant.id as string, token, expiresAt };
  }

  async getSetup(token: string) {
    const session = await this.requireSession(token, true);
    const tenantId = session.tenant_id as string;
    const [tenant, assistant, knowledge, services, subscription, addons, limits, modules, whatsapp] =
      await Promise.all([
        this.db.from("tenants").select("*").eq("id", tenantId).single(),
        this.db.from("assistant_profiles").select("*").eq("tenant_id", tenantId).maybeSingle(),
        this.db.from("knowledge_items").select("*").eq("tenant_id", tenantId).order("created_at"),
        this.db.from("services").select("*").eq("tenant_id", tenantId).order("created_at"),
        this.db.from("subscriptions").select("*").eq("tenant_id", tenantId).maybeSingle(),
        this.db.from("subscription_addons").select("*").eq("tenant_id", tenantId),
        this.db.from("tenant_usage_limits").select("*").eq("tenant_id", tenantId).maybeSingle(),
        this.db.from("module_settings").select("*").eq("tenant_id", tenantId),
        this.db
          .from("whatsapp_instances")
          .select("id, tenant_id, session_name, phone, status, last_health_check_at, created_at")
          .eq("tenant_id", tenantId)
          .maybeSingle(),
      ]);
    const results = [tenant, assistant, knowledge, services, subscription, addons, limits, modules, whatsapp];
    const failed = results.find((result) => result.error);
    if (failed?.error) databaseError("Could not load setup", failed.error);

    return {
      session: {
        status: session.status,
        current_step: session.current_step,
        completed_steps: session.completed_steps,
        expires_at: session.expires_at,
        completed_at: session.completed_at,
      },
      tenant: tenant.data,
      assistant: assistant.data,
      knowledge: knowledge.data,
      services: services.data,
      plan: { subscription: subscription.data, addons: addons.data, limits: limits.data, modules: modules.data },
      whatsapp: whatsapp.data,
    };
  }

  async updateBusiness(token: string, values: JsonObject) {
    return this.updateTenantStep(token, "business", "tenants", values);
  }

  async updateAssistant(token: string, values: JsonObject) {
    const session = await this.requireSession(token);
    const { data, error } = await this.db
      .from("assistant_profiles")
      .upsert({ tenant_id: session.tenant_id, ...values }, { onConflict: "tenant_id" })
      .select()
      .single();
    if (error) databaseError("Could not update assistant", error);
    await this.completeStep(session, "assistant");
    return data;
  }

  async replaceKnowledge(token: string, items: JsonObject[]) {
    const session = await this.requireSession(token);
    const tenantId = session.tenant_id as string;
    const rows = items.map((item) => ({ ...item, tenant_id: tenantId }));
    await this.replaceRows("knowledge_items", tenantId, rows);
    await this.completeStep(session, "knowledge");
    return rows.length;
  }

  async replaceServices(token: string, items: JsonObject[]) {
    const session = await this.requireSession(token);
    const tenantId = session.tenant_id as string;
    const rows = items.map((item) => ({ ...item, tenant_id: tenantId }));
    await this.replaceRows("services", tenantId, rows);
    await this.completeStep(session, "services");
    return rows.length;
  }

  async updatePlan(token: string, input: {
    subscription: JsonObject;
    addons: JsonObject[];
    limits?: JsonObject;
    modules: JsonObject[];
  }) {
    const session = await this.requireSession(token);
    const tenantId = session.tenant_id as string;
    const existing = await this.db.from("subscriptions").select("id").eq("tenant_id", tenantId).maybeSingle();
    if (existing.error) databaseError("Could not read subscription", existing.error);
    const subscriptionQuery = existing.data
      ? this.db.from("subscriptions").update(input.subscription).eq("id", existing.data.id)
      : this.db.from("subscriptions").insert({ tenant_id: tenantId, ...input.subscription });
    const { error: subscriptionError } = await subscriptionQuery;
    if (subscriptionError) databaseError("Could not update subscription", subscriptionError);

    await this.replaceRows(
      "subscription_addons",
      tenantId,
      input.addons.map((addon) => ({ ...addon, tenant_id: tenantId })),
    );
    if (input.limits) {
      const { error } = await this.db
        .from("tenant_usage_limits")
        .upsert({ tenant_id: tenantId, ...input.limits }, { onConflict: "tenant_id" });
      if (error) databaseError("Could not update usage limits", error);
    }
    for (const moduleSettings of input.modules) {
      const { error } = await this.db
        .from("module_settings")
        .upsert({ tenant_id: tenantId, ...moduleSettings }, { onConflict: "tenant_id,module_name" });
      if (error) databaseError("Could not update module settings", error);
    }
    await this.completeStep(session, "plan");
  }

  async updateWhatsapp(token: string, input: JsonObject) {
    const session = await this.requireSession(token);
    const tenantId = session.tenant_id as string;
    const values: JsonObject = {
      tenant_id: tenantId,
      waha_url: requireEnv("WAHA_URL"),
      session_name: input.session_name ?? "default",
      phone: input.phone,
      status: input.status ?? "active",
    };
    const encryptionKey = requireEnv("CREDENTIAL_ENCRYPTION_KEY");
    if (typeof input.webhook_secret === "string" && input.webhook_secret !== "") {
      values.webhook_secret_encrypted = encryptCredential(input.webhook_secret, encryptionKey);
    }
    const existing = await this.db.from("whatsapp_instances").select("id").eq("tenant_id", tenantId).maybeSingle();
    if (existing.error) databaseError("Could not read WhatsApp settings", existing.error);
    const query = existing.data
      ? this.db.from("whatsapp_instances").update(values).eq("id", existing.data.id)
      : this.db.from("whatsapp_instances").insert(values);
    const { data, error } = await query
      .select("id, tenant_id, session_name, phone, status, created_at")
      .single();
    if (error) databaseError("Could not update WhatsApp settings", error);
    await this.completeStep(session, "whatsapp");
    return data;
  }

  async complete(token: string) {
    const session = await this.requireSession(token);
    const tenantId = session.tenant_id as string;
    const { error: limitsError } = await this.db
      .from("tenant_usage_limits")
      .upsert({ tenant_id: tenantId }, { onConflict: "tenant_id", ignoreDuplicates: true });
    if (limitsError) databaseError("Could not create default usage limits", limitsError);
    const { error: modulesError } = await this.db
      .from("module_settings")
      .upsert(
        { tenant_id: tenantId, module_name: "knowledge", enabled: true },
        { onConflict: "tenant_id,module_name", ignoreDuplicates: true },
      );
    if (modulesError) databaseError("Could not create default module settings", modulesError);

    const completedAt = new Date().toISOString();
    const [tenantResult, sessionResult] = await Promise.all([
      this.db.from("tenants").update({ status: "trial" }).eq("id", tenantId),
      this.db
        .from("onboarding_sessions")
        .update({ status: "completed", completed_at: completedAt, current_step: "completed" })
        .eq("id", session.id),
    ]);
    if (tenantResult.error) databaseError("Could not activate tenant trial", tenantResult.error);
    if (sessionResult.error) databaseError("Could not complete onboarding", sessionResult.error);
    return { tenantId, status: "trial", completedAt };
  }

  async testKnowledge(token: string, question: string) {
    const session = await this.requireSession(token);
    const { data, error } = await this.db
      .from("knowledge_items")
      .select("id, question, answer, language")
      .eq("tenant_id", session.tenant_id)
      .eq("type", "faq")
      .eq("active", true)
      .not("question", "is", null);
    if (error) databaseError("Could not test knowledge", error);
    return findExactKnowledgeAnswer(
      question,
      (data ?? []).map((item) => ({
        id: item.id as string,
        question: item.question as string | null,
        answer: item.answer as string,
      })),
    );
  }

  private async requireSession(token: string, allowCompleted = false): Promise<JsonObject> {
    const { data, error } = await this.db
      .from("onboarding_sessions")
      .select("*")
      .eq("setup_token_hash", hashSetupToken(token))
      .maybeSingle();
    if (error) databaseError("Could not validate setup token", error);
    if (!data) throw new HttpError(404, "Invalid setup token");
    if (typeof data.expires_at !== "string" || Date.parse(data.expires_at) <= Date.now()) {
      throw new HttpError(410, "Setup token has expired");
    }
    if (!allowCompleted && data.status === "completed") {
      throw new HttpError(409, "Onboarding is already completed");
    }
    return data as JsonObject;
  }

  private async updateTenantStep(token: string, step: string, table: string, values: JsonObject) {
    const session = await this.requireSession(token);
    const { data, error } = await this.db
      .from(table)
      .update(values)
      .eq("id", session.tenant_id)
      .select()
      .single();
    if (error) databaseError(`Could not update ${step}`, error);
    await this.completeStep(session, step);
    return data;
  }

  private async completeStep(session: JsonObject, step: string): Promise<void> {
    const existing = Array.isArray(session.completed_steps) ? session.completed_steps : [];
    const completedSteps = [...new Set([...existing.filter((value): value is string => typeof value === "string"), step])];
    const { error } = await this.db
      .from("onboarding_sessions")
      .update({ status: "in_progress", current_step: step, completed_steps: completedSteps })
      .eq("id", session.id);
    if (error) databaseError("Could not update onboarding progress", error);
  }

  private async replaceRows(table: string, tenantId: string, rows: JsonObject[]): Promise<void> {
    const { error: deleteError } = await this.db.from(table).delete().eq("tenant_id", tenantId);
    if (deleteError) databaseError(`Could not replace ${table}`, deleteError);
    if (rows.length === 0) return;
    const { error: insertError } = await this.db.from(table).insert(rows);
    if (insertError) databaseError(`Could not replace ${table}`, insertError);
  }
}
