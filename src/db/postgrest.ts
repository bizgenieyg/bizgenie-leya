import { PostgrestClient } from "@supabase/postgrest-js";

export type DatabaseClient = PostgrestClient;

/**
 * Phase 1 uses only the Supabase Data API. Constructing PostgREST directly
 * deliberately avoids creating Auth, Storage, Functions, or Realtime clients.
 */
export function createDatabaseClient(url: string, serviceRoleKey: string): DatabaseClient {
  const baseUrl = new URL(url.endsWith("/") ? url : `${url}/`);
  const headers: Record<string, string> = {
    apikey: serviceRoleKey,
  };

  // New secret keys belong only in `apikey`; legacy service-role JWTs also
  // need the bearer header that supabase-js historically supplied.
  if (!serviceRoleKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${serviceRoleKey}`;
  }

  return new PostgrestClient(new URL("rest/v1", baseUrl).href, {
    headers,
    schema: "public",
  });
}
