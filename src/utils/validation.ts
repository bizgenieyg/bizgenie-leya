import { HttpError } from "./http-error.js";

export function objectBody(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HttpError(400, "Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

export function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, `${field} is required`);
  }
  return value.trim();
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
): string | null | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, `${field} must be a string or null`);
  }
  return value.trim();
}

export function requiredArray(
  body: Record<string, unknown>,
  field: string,
): unknown[] {
  const value = body[field];
  if (!Array.isArray(value)) {
    throw new HttpError(400, `${field} must be an array`);
  }
  return value;
}

export function pickDefined(
  body: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    allowed
      .filter((key) => body[key] !== undefined)
      .map((key) => [key, body[key]]),
  );
}
