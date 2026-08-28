import {
  createCipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

import { HttpError } from "./http-error.js";

export function createSetupToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashSetupToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function encryptCredential(value: string, encodedKey: string): string {
  let key: Buffer;
  try {
    key = Buffer.from(encodedKey, "base64");
  } catch {
    throw new HttpError(500, "Credential encryption is misconfigured");
  }
  if (key.length !== 32) {
    throw new HttpError(500, "CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}
