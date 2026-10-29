// Lets an agency owner or admin invite a teammate by email. The new person gets
// a Supabase invite email, sets a password, and must set up two-step
// verification before they can see anything.

import { callerClient, corsHeaders, isUuid, json, roleInAgency, serviceClient } from "../_shared/http.ts";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Use POST." }, 405);

  let body: { agencyId?: unknown; email?: unknown; role?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Send JSON with agencyId, email and role." }, 400);
  }
  const { agencyId, email, role } = body;
  if (!isUuid(agencyId) || typeof email !== "string" || !EMAIL.test(email) || (role !== "staff" && role !== "admin")) {
    return json({ error: "Send a valid agencyId, an email address, and a role of staff or admin." }, 400);
  }

  const member = await roleInAgency(callerClient(req), agencyId);
  if (!member || (member.role !== "owner" && member.role !== "admin")) {
    return json({ error: "Only owners and admins can invite people." }, 403);
  }

  const admin = serviceClient();
  const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email.trim().toLowerCase(), {
    redirectTo: Deno.env.get("APP_ORIGIN") ?? undefined,
  });
  if (error || !invited.user) {
    const exists = error?.message?.toLowerCase().includes("already");
    return json(
      { error: exists ? "That email already has a CIS Tech account. Contact support to add them to your agency." : "The invite couldn't be sent." },
      exists ? 409 : 502,
    );
  }

  const { error: insertError } = await admin
    .from("memberships")
    .insert({ agency_id: agencyId, user_id: invited.user.id, role, email: invited.user.email });
  if (insertError) return json({ error: "The invite was sent but the person couldn't be added. Try again." }, 500);

  return json({ ok: true });
});
