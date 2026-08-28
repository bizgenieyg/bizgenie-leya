import "dotenv/config";

const DEFAULT_PORT = 3000;

function optionalPort(value: string | undefined): number {
  if (value === undefined || value.trim() === "") {
    return DEFAULT_PORT;
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }

  return port;
}

export const env = Object.freeze({
  port: optionalPort(process.env.PORT),
  supabaseUrl: process.env.SUPABASE_URL,
  supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
});

export function requireSupabaseEnv(): {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
} {
  if (!env.supabaseUrl) {
    throw new Error("Missing required environment variable: SUPABASE_URL");
  }
  if (!env.supabaseServiceRoleKey) {
    throw new Error(
      "Missing required environment variable: SUPABASE_SERVICE_ROLE_KEY",
    );
  }

  return {
    supabaseUrl: env.supabaseUrl,
    supabaseServiceRoleKey: env.supabaseServiceRoleKey,
  };
}
