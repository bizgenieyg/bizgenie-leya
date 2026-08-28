import type { NextFunction, Request, Response } from "express";

import { requireEnv } from "../config/env.js";
import { secretsMatch } from "./crypto.js";
import { HttpError } from "./http-error.js";

export function requireAdmin(
  request: Request,
  _response: Response,
  next: NextFunction,
): void {
  const authorization = request.header("authorization");
  const provided = authorization?.startsWith("Bearer ")
    ? authorization.slice(7)
    : request.header("x-admin-secret");

  if (!provided || !secretsMatch(provided, requireEnv("ADMIN_SECRET"))) {
    throw new HttpError(401, "Unauthorized");
  }

  next();
}
