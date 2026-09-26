import { startEscalationScheduler } from "./workers/escalation-scheduler.js";
import { startInboundQueue } from './workers/inbound-queue.js';
import { startOutboundQueue } from './workers/outbound-queue.js';
import { startWahaMonitor } from './workers/waha-monitor.js';
import { deepHealth } from './services/deep-health.service.js';
import { requireAdmin } from './utils/admin-auth.js';
import { sendPlatformAlert } from './services/platform-alerts.service.js';
import { modelKeyConfigured } from './providers/ai/index.js';
import express from "express";

import { env } from "./config/env.js";
import { adminRouter } from "./routes/admin.js";
import { adminOnboardingRouter, setupRouter } from "./routes/setup.routes.js";
import { adminReportsRouter } from "./routes/reports.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";
import { HttpError } from "./utils/http-error.js";

// Keep all available call sites for asynchronous worker failure diagnostics.
Error.stackTraceLimit = Infinity;

export const app = express();

app.disable("x-powered-by");
app.set('trust proxy', 'loopback');
app.use(
  express.json({
    // Keep the exact bytes so webhook HMAC verification is not broken by
    // re-serialization (Cyrillic/Hebrew payloads change under JSON.stringify).
    verify: (request, _response, buffer) => {
      (request as express.Request & { rawBody?: Buffer }).rawBody =
        Buffer.from(buffer);
    },
  }),
);

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});
app.get('/health/deep', requireAdmin, async (_request, response) => {
  const health = await deepHealth();
  response.status(health.status === 'ok' ? 200 : 503).json(health);
});

app.use("/admin/onboarding", adminOnboardingRouter);
app.use("/admin/reports", adminReportsRouter);
app.use("/api/admin", adminRouter);
app.use("/setup", setupRouter);
app.use("/webhook", webhookRouter);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message, ...error.details });
    return;
  }
  console.error("Unhandled request error");
  response.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  startEscalationScheduler();
  startInboundQueue();
  startOutboundQueue();
  startWahaMonitor();
  process.on('unhandledRejection', () => {
    console.error('unhandled_rejection');
    void sendPlatformAlert('unhandled_rejection', 'leya-api: необработанная ошибка Promise');
  });
  process.on('uncaughtException', () => {
    console.error('uncaught_exception');
    void sendPlatformAlert('uncaught_exception', 'leya-api: необработанное исключение');
    // The process cannot safely continue after an uncaught exception.
    setTimeout(() => process.exit(1), 1000).unref();
  });
  app.listen(env.port, () => {
    console.log(`Leya backend listening on port ${env.port}`);
    void sendPlatformAlert('api_started', 'leya-api перезапущен');
    // A missing model key would otherwise only surface after three failed client messages.
    if (!modelKeyConfigured()) void sendPlatformAlert('model_key_missing', '⚠️ Не задан ключ модели: ассистент отвечает заглушкой.');
  });
}
