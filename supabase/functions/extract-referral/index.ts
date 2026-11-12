// Reads a pasted referral with Claude and returns the fields for the intake form.
//
// Only signed-in members of the agency with two-step verification can call it
// (the database enforces both). Referral text goes to Claude under Anthropic's
// BAA and is never written to logs here; the audit log records only that an
// extraction happened and who ran it.

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { PAYER_IDS, PAYERS, PROVIDER_TYPES, SERVICE_IDS, SERVICES, labelOf } from "../_shared/catalog.ts";
import { appUrl, callerClient, corsHeaders, isUuid, json, roleInAgency, serviceClient } from "../_shared/http.ts";

const MAX_TEXT = 20_000;

const ReferralFields = z.object({
  source: z.string().describe("Referring hospital, practice or agency"),
  sourceContact: z.string().describe("Contact person's name, role and phone as written"),
  patientInitials: z.string().describe('Initials only, like "R.M.". Never a full name'),
  age: z.number().int().nullable(),
  diagnosis: z.string().describe("Short list of the main diagnoses"),
  needs: z.array(z.enum(SERVICE_IDS)),
  payer: z.enum([...PAYER_IDS, ""]),
  location: z.string().describe("County or city where care will happen, as written"),
  startDate: z.string().describe("YYYY-MM-DD, or empty if not stated"),
  notes: z.string().describe("One or two sentences of anything else a reviewer should know, or empty"),
});

// ANTHROPIC_API_KEY comes from an organization with a signed BAA. Created on first use so a
// missing key gives a clear error instead of stopping the function from starting.
let anthropic: Anthropic | null = null;

function buildPrompt(text: string, providerType: string, today: string): string {
  return `You read healthcare referrals (hospital discharge, physician office or case manager referrals) for a ${labelOf(PROVIDER_TYPES, providerType).toLowerCase()} admissions team and pull out the fields they need to decide quickly.

Rules:
- patientInitials: initials only. Never write a patient's full name anywhere in your answer.
- needs: every service the patient will need. Use only these ids: ${SERVICES.map(([id, l]) => `${id} (${l})`).join(", ")}. Skilled nursing visits mean skilled_nursing. Hospice referrals include hospice_comfort.
- payer: one of ${PAYERS.map(([id, l]) => `${id} (${l})`).join(", ")}. Medicare Part A or B is medicare. Empty string if unclear.
- startDate: the requested start of care or discharge date. Today is ${today}; resolve words like "tomorrow" or "Friday".
- Use an empty string for anything the referral doesn't say.

Referral:
<referral>
${text}
</referral>`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, { error: "Use POST." }, 405);

  let body: { agencyId?: unknown; text?: unknown };
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "Send JSON with agencyId and text." }, 400);
  }
  const { agencyId, text } = body;
  if (!isUuid(agencyId) || typeof text !== "string" || !text.trim()) {
    return json(req, { error: "Send JSON with agencyId and text." }, 400);
  }
  if (text.length > MAX_TEXT) return json(req, { error: `Referral text is over ${MAX_TEXT} characters.` }, 413);

  const caller = callerClient(req);
  const member = await roleInAgency(caller, agencyId);
  if (!member) return json(req, { error: "Sign in with two-step verification as a member of this agency." }, 403);

  const { data: agency } = await caller.from("agencies").select("provider_type").eq("id", agencyId).single();

  if (!Deno.env.get("ANTHROPIC_API_KEY")) {
    console.error("extract-referral: ANTHROPIC_API_KEY is not set");
    return json(req, { error: "Reading with Claude isn't set up yet. Fill in the form by hand." }, 503);
  }
  anthropic ??= new Anthropic();

  let fields: z.infer<typeof ReferralFields>;
  try {
    const response = await anthropic.beta.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low", format: betaZodOutputFormat(ReferralFields) },
      messages: [
        { role: "user", content: buildPrompt(text, agency?.provider_type ?? "home_health", new Date().toISOString().slice(0, 10)) },
      ],
    });
    if (response.stop_reason === "refusal" || !response.parsed_output) {
      return json(req, { error: "Claude couldn't read this referral. Fill in the form by hand." }, 422);
    }
    fields = response.parsed_output;
  } catch (err) {
    // Log the error type only. Never log the referral text or the response.
    if (err instanceof Anthropic.RateLimitError) {
      console.error("extract-referral: rate limited");
      return json(req, { error: "Too many requests right now. Try again in a minute." }, 429);
    }
    if (err instanceof Anthropic.APIError) {
      console.error(`extract-referral: Claude API error ${err.status}`);
      return json(req, { error: "Claude is unavailable right now. Fill in the form by hand." }, 502);
    }
    // SDK errors carry no referral text; for anything else log only the error type.
    const detail = err instanceof Anthropic.AnthropicError ? `${err.name}: ${err.message.slice(0, 200)}` : (err as Error)?.name ?? "unknown";
    console.error(`extract-referral: unexpected error (${detail})`);
    return json(req, { error: "Something went wrong reading the referral." }, 500);
  }

  await serviceClient().from("audit_log").insert({
    actor: member.userId,
    agency_id: agencyId,
    action: "ai_extract",
    table_name: "referrals",
  });

  if (!/^\d{4}-\d{2}-\d{2}$/.test(fields.startDate)) fields.startDate = "";
  return json(req, { fields });
});
