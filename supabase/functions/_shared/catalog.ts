// The services, payers and provider types CIS Tech understands. Shared by the
// edge functions and the web app so Claude's answers and the form always agree.

export const SERVICES = [
  ["skilled_nursing", "Skilled nursing"],
  ["wound_care", "Wound care"],
  ["iv_therapy", "IV therapy / infusions"],
  ["pt", "Physical therapy"],
  ["ot", "Occupational therapy"],
  ["st", "Speech therapy"],
  ["diabetes_mgmt", "Diabetes management"],
  ["ostomy", "Ostomy care"],
  ["catheter", "Catheter care"],
  ["oxygen", "Oxygen"],
  ["trach", "Tracheostomy care"],
  ["ventilator", "Ventilator"],
  ["dialysis", "Dialysis"],
  ["tpn", "TPN / tube feeding"],
  ["bariatric", "Bariatric care"],
  ["memory_care", "Memory care / dementia"],
  ["behavioral", "Behavioral health"],
  ["aide", "Home health aide"],
  ["hospice_comfort", "Hospice comfort care"],
  ["palliative", "Palliative care"],
] as const;

export const PAYERS = [
  ["medicare", "Medicare"],
  ["medicare_advantage", "Medicare Advantage"],
  ["medicaid", "Medicaid"],
  ["private_insurance", "Commercial insurance"],
  ["va", "VA"],
  ["private_pay", "Private pay"],
] as const;

export const PROVIDER_TYPES = [
  ["home_health", "Home health agency"],
  ["hospice", "Hospice"],
  ["snf", "Nursing home / SNF"],
] as const;

export type ServiceId = (typeof SERVICES)[number][0];
export type PayerId = (typeof PAYERS)[number][0];
export type ProviderType = (typeof PROVIDER_TYPES)[number][0];

export const SERVICE_IDS = SERVICES.map((s) => s[0]) as [ServiceId, ...ServiceId[]];
export const PAYER_IDS = PAYERS.map((p) => p[0]) as [PayerId, ...PayerId[]];

export function labelOf(list: readonly (readonly [string, string])[], id: string | null | undefined): string {
  return list.find((x) => x[0] === id)?.[1] ?? id ?? "";
}
