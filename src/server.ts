import express from "express";

import { env } from "./config/env.js";

export const app = express();

app.disable("x-powered-by");
app.use(express.json());

app.get("/health", (_request, response) => {
  response.status(200).json({ status: "ok" });
});

if (require.main === module) {
  app.listen(env.port, () => {
    console.log(`Leia backend listening on port ${env.port}`);
  });
}
