import express from "express";

import { env } from "./config/env.js";
import { adminRouter } from "./routes/admin.js";
import { adminOnboardingRouter, setupRouter } from "./routes/setup.routes.js";
import { adminReportsRouter } from "./routes/reports.routes.js";
import { webhookRouter } from "./routes/webhook.routes.js";
import { HttpError } from "./utils/http-error.js";

export const app = express();

app.disable("x-powered-by");
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

app.use("/admin/onboarding", adminOnboardingRouter);
app.use("/admin/reports", adminReportsRouter);
app.use("/api/admin", adminRouter);
app.use("/setup", setupRouter);
app.use("/webhook", webhookRouter);

app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
  if (error instanceof HttpError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  console.error("Unhandled request error");
  response.status(500).json({ error: "Internal server error" });
});

if (require.main === module) {
  app.listen(env.port, () => {
    console.log(`Leia backend listening on port ${env.port}`);
  });
}
