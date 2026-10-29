import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const allowedOrigin = Deno.env.get("APP_ORIGIN") ?? "";

export const corsHeaders = {
  "Access-Control-Allow-Origin": allowedOrigin,
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Vary": "Origin",
};

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** A client that acts as the caller, so row level security applies to every query. */
export function callerClient(req: Request): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
}

/** A client that bypasses row level security. Use only after checking the caller. */
export function serviceClient(): SupabaseClient {
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
}

/** The caller's role in the agency, or null. Needs two-step verification (enforced by the database). */
export async function roleInAgency(caller: SupabaseClient, agencyId: string): Promise<{ userId: string; role: string } | null> {
  const { data: auth } = await caller.auth.getUser();
  if (!auth.user) return null;
  const { data } = await caller
    .from("memberships")
    .select("role")
    .eq("agency_id", agencyId)
    .eq("user_id", auth.user.id)
    .maybeSingle();
  return data ? { userId: auth.user.id, role: data.role } : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);
