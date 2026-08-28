import { createClient } from "@supabase/supabase-js";

import { requireSupabaseEnv } from "../config/env.js";

const { supabaseUrl, supabaseServiceRoleKey } = requireSupabaseEnv();

export const supabase = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
