import { PAYERS, SERVICES, labelOf } from "./catalog";

export type Verdict = "accept" | "review" | "decline";
export type Reason = { kind: "ok" | Verdict; text: string; reply?: string };
export type Recommendation = { verdict: Verdict; reasons: Reason[] };

export type ReferralInput = {
  needs: string[];
  payer: string | null;
  location: string | null;
  diagnosis: string | null;
};

export type Profile = {
  open_slots: number;
  service_area: string[];
  services: string[];
  payers: string[];
};

const ORDER = { decline: 0, review: 1, ok: 2, accept: 2 } as const;

/** Checks a referral against what the agency can take on. Pure, so it runs the same everywhere. */
export function recommend(r: ReferralInput, p: Profile | null): Recommendation {
  if (!p) return { verdict: "review", reasons: [{ kind: "review", text: "Set up your facility profile so referrals can be checked." }] };
  const reasons: Reason[] = [];
  const services = new Set(p.services);

  for (const n of r.needs) {
    const name = labelOf(SERVICES, n);
    reasons.push(services.has(n)
      ? { kind: "ok", text: `${name} is a service you provide` }
      : { kind: "decline", text: `${name} is not in your services`, reply: `we don't provide ${name.toLowerCase()}` });
  }
  if (!r.needs.length) reasons.push({ kind: "review", text: "No care needs listed. Confirm the orders." });

  if (!r.payer) {
    reasons.push({ kind: "review", text: "Payer not given. Verify insurance." });
  } else {
    const name = labelOf(PAYERS, r.payer);
    reasons.push(p.payers.includes(r.payer)
      ? { kind: "ok", text: `${name} is accepted` }
      : { kind: "decline", text: `${name} is not a payer you accept`, reply: `we don't accept ${name}` });
  }

  const areas = p.service_area.map((a) => a.toLowerCase().trim()).filter(Boolean);
  const loc = (r.location ?? "").trim();
  if (!loc) reasons.push({ kind: "review", text: "Patient location not given." });
  else if (!areas.length) reasons.push({ kind: "review", text: "Add your service area to the profile." });
  else {
    const l = loc.toLowerCase();
    reasons.push(areas.some((a) => l.includes(a) || a.includes(l))
      ? { kind: "ok", text: `${loc} is in your service area` }
      : { kind: "decline", text: `${loc} is outside your service area`, reply: `${loc} is outside our service area` });
  }

  reasons.push(p.open_slots > 0
    ? { kind: "ok", text: `${p.open_slots} ${p.open_slots === 1 ? "opening" : "openings"} available` }
    : { kind: "decline", text: "No openings right now", reply: "we have no openings right now" });

  if (!r.diagnosis?.trim()) reasons.push({ kind: "review", text: "Diagnosis missing." });

  const verdict: Verdict = reasons.some((x) => x.kind === "decline") ? "decline"
    : reasons.some((x) => x.kind === "review") ? "review" : "accept";
  reasons.sort((a, b) => ORDER[a.kind] - ORDER[b.kind]);
  return { verdict, reasons };
}

export function replyText(
  r: { source_contact: string | null; source: string | null; patient_initials: string | null; start_date: string | null },
  decision: "accepted" | "declined",
  rec: Recommendation,
  agencyName: string,
): string {
  const who = (r.source_contact || r.source || "there").split(",")[0].trim();
  const pt = r.patient_initials || "this patient";
  if (decision === "accepted") {
    const when = r.start_date ? formatDate(r.start_date) : "the requested date";
    return `Hi ${who}, thank you for the referral for ${pt}. ${agencyName} can accept and start care on ${when}. Please send the orders and clinical records so we can complete intake.`;
  }
  const why = rec.reasons.filter((x) => x.kind === "decline").map((x) => x.reply ?? x.text).join("; ");
  return `Hi ${who}, thank you for thinking of ${agencyName} for ${pt}. We are not able to accept this referral${why ? ` (${why})` : ""}. We appreciate the referral and hope to help with the next one.`;
}

export function formatDate(d: string): string {
  const dt = new Date(`${d}T12:00:00`);
  return Number.isNaN(dt.getTime()) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
