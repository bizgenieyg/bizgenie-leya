import { Router } from "express";

import { WahaAdminService } from "../services/waha-admin.service.js";
import { isUuid } from "../services/tenant.service.js";
import { requireAdmin } from "../utils/admin-auth.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody, requiredString } from "../utils/validation.js";

const waha = new WahaAdminService();

export const adminRouter = Router();
adminRouter.use(requireAdmin);

function queryTenantId(value: unknown): string {
  if (typeof value !== "string" || !isUuid(value)) {
    throw new HttpError(400, "tenantId must be a UUID");
  }
  return value;
}

adminRouter.post("/waha/create", async (request, response) => {
  const tenantId = requiredString(objectBody(request.body), "tenantId");
  if (!isUuid(tenantId)) throw new HttpError(400, "tenantId must be a UUID");
  response.status(201).json(await waha.create(tenantId));
});

adminRouter.get("/waha/qr", async (request, response) => {
  const qr = await waha.qr(queryTenantId(request.query.tenantId));
  response.setHeader("Content-Type", qr.contentType);
  response.setHeader("Cache-Control", "no-store");
  response.status(200).send(qr.data);
});

adminRouter.get("/waha/status", async (request, response) => {
  response.json(await waha.status(queryTenantId(request.query.tenantId)));
});

adminRouter.post("/waha/reconnect", async (request, response) => {
  response.json(await waha.reconnect(queryTenantId(request.query.tenantId)));
});

adminRouter.post("/waha/disconnect", async (request, response) => {
  response.json(await waha.disconnect(queryTenantId(request.query.tenantId)));
});
