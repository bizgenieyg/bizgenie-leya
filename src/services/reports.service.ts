import { supabase, type DatabaseClient } from "../db/supabase.js";
import { HttpError } from "../utils/http-error.js";
import {
  groupTopUnknownQuestions,
  type UnknownQuestionCount,
  type UnknownQuestionRow,
} from "./reports.utils.js";

const REPORT_PERIOD_DAYS = 7;
const PAGE_SIZE = 1_000;
const DEFAULT_UNKNOWN_LIMIT = 5;

export interface WeeklyReportData {
  tenantId: string;
  periodStart: string;
  periodEnd: string;
  messageCount: number;
  newClientsCount: number;
  escalationCount: number;
  topUnknownQuestions: UnknownQuestionCount[];
}

function reportError(message: string): never {
  throw new HttpError(500, message);
}

export class ReportsService {
  constructor(private readonly db: DatabaseClient = supabase) {}

  async createWeeklyReportJob(
    tenantId: string,
    scheduledAt = new Date(),
  ): Promise<Record<string, unknown>> {
    const { data, error } = await this.db
      .from("scheduled_jobs")
      .insert({
        tenant_id: tenantId,
        job_type: "weekly_report",
        payload: { period_days: REPORT_PERIOD_DAYS },
        scheduled_at: scheduledAt.toISOString(),
        status: "pending",
      })
      .select("id, tenant_id, job_type, payload, scheduled_at, status")
      .single();

    if (error || !data) reportError("Could not create weekly report job");
    return data as Record<string, unknown>;
  }

  async getWeeklyReportData(
    tenantId: string,
    options: { now?: Date; unknownLimit?: number } = {},
  ): Promise<WeeklyReportData> {
    const periodEnd = options.now ?? new Date();
    const periodStart = new Date(
      periodEnd.getTime() - REPORT_PERIOD_DAYS * 24 * 60 * 60 * 1_000,
    );
    const startIso = periodStart.toISOString();
    const endIso = periodEnd.toISOString();

    const [tenant, messages, clients, escalations] = await Promise.all([
      this.db.from("tenants").select("id").eq("id", tenantId).maybeSingle(),
      this.db
        .from("messages")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("created_at", startIso)
        .lte("created_at", endIso),
      this.db
        .from("clients")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .gte("first_seen_at", startIso)
        .lte("first_seen_at", endIso),
      this.db
        .from("agent_actions")
        .select("*", { count: "exact", head: true })
        .eq("tenant_id", tenantId)
        .eq("action_type", "escalation_created")
        .not("output", "is", null)
        .gte("created_at", startIso)
        .lte("created_at", endIso),
    ]);

    if (tenant.error) reportError("Could not validate report tenant");
    if (!tenant.data) throw new HttpError(404, "Tenant not found");
    if (messages.error || clients.error || escalations.error) {
      reportError("Could not query weekly report counts");
    }

    const unknownRows = await this.fetchEscalationInputs(
      tenantId,
      startIso,
      endIso,
    );

    return {
      tenantId,
      periodStart: startIso,
      periodEnd: endIso,
      messageCount: messages.count ?? 0,
      newClientsCount: clients.count ?? 0,
      escalationCount: escalations.count ?? 0,
      topUnknownQuestions: groupTopUnknownQuestions(
        unknownRows,
        options.unknownLimit ?? DEFAULT_UNKNOWN_LIMIT,
      ),
    };
  }

  private async fetchEscalationInputs(
    tenantId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<UnknownQuestionRow[]> {
    const rows: UnknownQuestionRow[] = [];

    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await this.db
        .from("agent_actions")
        .select("input, output")
        .eq("tenant_id", tenantId)
        .eq("action_type", "escalation_created")
        .not("output", "is", null)
        .gte("created_at", periodStart)
        .lte("created_at", periodEnd)
        .not("input", "is", null)
        .order("created_at", { ascending: true })
        .order("id", { ascending: true })
        .range(from, from + PAGE_SIZE - 1);

      if (error) reportError("Could not query unknown questions");
      const page = (data ?? []) as UnknownQuestionRow[];
      rows.push(...page);
      if (page.length < PAGE_SIZE) break;
    }

    return rows;
  }
}
