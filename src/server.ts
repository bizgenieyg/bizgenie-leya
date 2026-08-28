import express from "express";

import { env } from "./config/env.js";
import { adminOnboardingRouter, setupRouter } from "./routes/setup.routes.js";
import { HttpError } from "./utils/http-error.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

app.use("/admin/onboarding", adminOnboardingRouter);
app.use("/setup", setupRouter);

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
