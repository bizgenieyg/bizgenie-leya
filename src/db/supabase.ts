import { requireSupabaseEnv } from "../config/env.js";
import { createDatabaseClient } from "./postgrest.js";

export type { DatabaseClient } from "./postgrest.js";

const { supabaseUrl, supabaseServiceRoleKey } = requireSupabaseEnv();

export const supabase = createDatabaseClient(supabaseUrl, supabaseServiceRoleKey);
