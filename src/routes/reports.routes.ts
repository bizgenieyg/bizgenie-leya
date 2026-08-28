import { Router } from "express";

import { ReportsService } from "../services/reports.service.js";
import { requireAdmin } from "../utils/admin-auth.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody, optionalString, requiredString } from "../utils/validation.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const reports = new ReportsService();

export const adminReportsRouter = Router();
adminReportsRouter.use(requireAdmin);

adminReportsRouter.post("/weekly/jobs", async (request, response) => {
  const body = objectBody(request.body);
  const tenantId = requiredString(body, "tenant_id");
  if (!UUID_PATTERN.test(tenantId)) throw new HttpError(400, "tenant_id must be a UUID");

  const scheduledAtValue = optionalString(body, "scheduled_at");
  const scheduledAt = scheduledAtValue ? new Date(scheduledAtValue) : new Date();
  if (Number.isNaN(scheduledAt.getTime())) {
    throw new HttpError(400, "scheduled_at must be a valid date-time");
  }

  response.status(201).json(await reports.createWeeklyReportJob(tenantId, scheduledAt));
});

adminReportsRouter.get("/weekly/:tenantId", async (request, response) => {
  const tenantId = request.params.tenantId;
  if (!UUID_PATTERN.test(tenantId)) throw new HttpError(400, "tenantId must be a UUID");

  const rawLimit = request.query.top_limit;
  const topLimit = rawLimit === undefined ? 5 : Number(rawLimit);
  if (!Number.isInteger(topLimit) || topLimit < 1 || topLimit > 20) {
    throw new HttpError(400, "top_limit must be an integer between 1 and 20");
  }

  response.json(
    await reports.getWeeklyReportData(tenantId, { unknownLimit: topLimit }),
  );
});
