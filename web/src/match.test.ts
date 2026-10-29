import { describe, expect, it } from "vitest";
import { recommend, replyText, type Profile } from "./match";

const profile: Profile = {
  open_slots: 2,
  service_area: ["Franklin County", "Columbus"],
  services: ["skilled_nursing", "wound_care", "pt"],
  payers: ["medicare", "medicaid"],
};

const base = { needs: ["skilled_nursing", "pt"], payer: "medicare", location: "Franklin County", diagnosis: "Hip replacement" };

describe("recommend", () => {
  it("recommends accepting a referral that fits on every count", () => {
    const r = recommend(base, profile);
    expect(r.verdict).toBe("accept");
    expect(r.reasons.every((x) => x.kind === "ok")).toBe(true);
  });

  it("declines a service the agency doesn't provide, and lists that first", () => {
    const r = recommend({ ...base, needs: ["pt", "ventilator"] }, profile);
    expect(r.verdict).toBe("decline");
    expect(r.reasons[0].text).toBe("Ventilator is not in your services");
  });

  it("declines a payer the agency doesn't accept", () => {
    expect(recommend({ ...base, payer: "va" }, profile).verdict).toBe("decline");
  });

  it("matches the service area in either direction, ignoring case", () => {
    expect(recommend({ ...base, location: "columbus, OH" }, profile).verdict).toBe("accept");
    expect(recommend({ ...base, location: "Franklin" }, profile).verdict).toBe("accept");
    expect(recommend({ ...base, location: "Pickaway County" }, profile).verdict).toBe("decline");
  });

  it("declines when there are no openings", () => {
    expect(recommend(base, { ...profile, open_slots: 0 }).verdict).toBe("decline");
  });

  it("asks for review when details are missing", () => {
    expect(recommend({ ...base, payer: null }, profile).verdict).toBe("review");
    expect(recommend({ ...base, diagnosis: "" }, profile).verdict).toBe("review");
    expect(recommend({ ...base, needs: [] }, profile).verdict).toBe("review");
    expect(recommend(base, null).verdict).toBe("review");
  });
});

describe("replyText", () => {
  const ref = { source_contact: "Dana W., RN, 614-555-0142", source: "Riverside", patient_initials: "R.M.", start_date: "2026-10-30" };

  it("writes an acceptance addressed to the contact", () => {
    const text = replyText(ref, "accepted", recommend(base, profile), "Sample Home Health");
    expect(text).toContain("Hi Dana W.,");
    expect(text).toContain("for R.M. Sample Home Health");
    expect(text).toContain("Sample Home Health can accept and start care on Oct 30");
  });

  it("explains a decline in the agency's own voice", () => {
    const rec = recommend({ ...base, needs: ["dialysis"], location: "Licking County" }, profile);
    const text = replyText(ref, "declined", rec, "Sample Home Health");
    expect(text).toContain("we don't provide dialysis; Licking County is outside our service area");
    expect(text).not.toContain("your");
  });
});
