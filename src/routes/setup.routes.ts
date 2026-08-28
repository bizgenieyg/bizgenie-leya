import { Router } from "express";

import { requireEnv } from "../config/env.js";
import { OnboardingService } from "../services/onboarding.service.js";
import { secretsMatch } from "../utils/crypto.js";
import { HttpError } from "../utils/http-error.js";
import { objectBody, optionalString, pickDefined, requiredArray, requiredString } from "../utils/validation.js";

const service = new OnboardingService();

export const adminOnboardingRouter = Router();
export const setupRouter = Router();

adminOnboardingRouter.post("/create", async (request, response) => {
  const authorization = request.header("authorization");
  const provided = authorization?.startsWith("Bearer ") ? authorization.slice(7) : request.header("x-admin-secret");
  if (!provided || !secretsMatch(provided, requireEnv("ADMIN_SECRET"))) {
    throw new HttpError(401, "Unauthorized");
  }
  const body = objectBody(request.body);
  const businessName = optionalString(body, "business_name");
  const result = await service.createTenant({
    name: requiredString(body, "name"),
    phone: requiredString(body, "phone"),
    ...(businessName !== undefined ? { businessName } : {}),
  });
  response.status(201).json(result);
});

setupRouter.get("/:token", async (request, response) => {
  response.json(await service.getSetup(request.params.token));
});

setupRouter.patch("/:token/business", async (request, response) => {
  const body = objectBody(request.body);
  const values = pickDefined(body, ["name", "business_name", "phone", "birthday", "language"]);
  if (Object.keys(values).length === 0) throw new HttpError(400, "No business fields supplied");
  response.json(await service.updateBusiness(request.params.token, values));
});

setupRouter.patch("/:token/assistant", async (request, response) => {
  const body = objectBody(request.body);
  const values = pickDefined(body, ["assistant_name", "tone", "mode", "allowed_languages", "system_rules", "style_profile_md"]);
  if (Object.keys(values).length === 0) throw new HttpError(400, "No assistant fields supplied");
  response.json(await service.updateAssistant(request.params.token, values));
});

setupRouter.patch("/:token/knowledge", async (request, response) => {
  const items = requiredArray(objectBody(request.body), "items").map((value) => {
    const item = objectBody(value);
    requiredString(item, "type");
    requiredString(item, "answer");
    return pickDefined(item, ["type", "question", "answer", "language", "active", "source"]);
  });
  response.json({ replaced: await service.replaceKnowledge(request.params.token, items) });
});

setupRouter.patch("/:token/services", async (request, response) => {
  const items = requiredArray(objectBody(request.body), "items").map((value) => {
    const item = objectBody(value);
    requiredString(item, "name");
    return pickDefined(item, ["name", "description", "price_min", "price_max", "fixed_price", "duration_minutes", "active"]);
  });
  response.json({ replaced: await service.replaceServices(request.params.token, items) });
});

setupRouter.patch("/:token/plan", async (request, response) => {
  const body = objectBody(request.body);
  const subscription = objectBody(body.subscription);
  requiredString(subscription, "tier");
  const addons = requiredArray(body, "addons").map(objectBody);
  const modules = requiredArray(body, "modules").map((value) => {
    const moduleSettings = objectBody(value);
    requiredString(moduleSettings, "module_name");
    return moduleSettings;
  });
  const limits = body.limits === undefined ? undefined : objectBody(body.limits);
  await service.updatePlan(request.params.token, {
    subscription,
    addons,
    modules,
    ...(limits !== undefined ? { limits } : {}),
  });
  response.json({ updated: true });
});

setupRouter.patch("/:token/whatsapp", async (request, response) => {
  response.json(await service.updateWhatsapp(request.params.token, objectBody(request.body)));
});

setupRouter.post("/:token/complete", async (request, response) => {
  response.json(await service.complete(request.params.token));
});

setupRouter.post("/:token/test", async (request, response) => {
  const question = requiredString(objectBody(request.body), "question");
  response.json(await service.testKnowledge(request.params.token, question));
});
