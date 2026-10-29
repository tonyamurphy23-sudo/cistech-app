# HIPAA checklist for CIS Tech

The code in this repository provides the technical safeguards below. HIPAA
compliance also depends on signed agreements, Supabase and Anthropic settings,
and written policies that only CIS Tech can put in place. Nothing here is legal
advice: have a HIPAA consultant or healthcare attorney review the program
before the first real referral goes in.

## 1. Agreements (do these first)

| Who | What to sign | Notes |
|---|---|---|
| Supabase | Business Associate Agreement (BAA) | Requires the **Team plan or higher** plus the **HIPAA add-on**. Request it from the Supabase dashboard (Organization settings → Legal documents) or Supabase sales. |
| Anthropic | BAA for the Claude API | Ask Anthropic sales for a BAA on CIS Tech's API organization, and confirm the "HIPAA-ready" configuration is turned on for it. Use that organization's API key only. |
| Email provider used for sign-in and invite emails | BAA, or keep emails free of patient information | The app's emails contain only links, no patient details. Use a provider that will sign a BAA anyway (set it in Supabase → Authentication → SMTP). |
| Each customer agency | Your BAA with them | CIS Tech is their business associate. Have your attorney prepare a standard BAA customers sign at onboarding. |
| Web host for the app (Netlify, Vercel, Cloudflare Pages) | Usually not needed | The host serves only the app's code. Patient data goes straight from the browser to Supabase and never passes through the host. Confirm with your consultant. |

## 2. Supabase project settings

Do all of these on the project marked as HIPAA in Supabase:

- [ ] Mark the project as a HIPAA project (Project settings → General) once the add-on is active.
- [ ] Turn on **Point-in-Time Recovery** (backups) under Database → Backups.
- [ ] **Enforce SSL** for database connections (Database → Settings).
- [ ] **Network restrictions**: allow direct database connections only from addresses you control.
- [ ] Require **multi-factor authentication** for everyone on the Supabase organization (Organization settings → Security).
- [ ] Authentication → Providers: email/password only; turn off open sign-ups after your first agency is created if you onboard customers yourself.
- [ ] Authentication → Multi-Factor: TOTP enabled (the app requires it for every user).
- [ ] Authentication → Sessions: set an inactivity timeout (for example 30 minutes) and a maximum session length (for example 12 hours).
- [ ] Authentication → Passwords: minimum length 12, leaked password protection on.
- [ ] Turn on the **pgaudit** extension and keep database and API logs (Supabase log retention depends on the plan; export logs if you need six years).
- [ ] Do not use the Supabase SQL editor or table viewer on real patient data except for a documented support need.

## 3. What the code already does

| Safeguard | Where |
|---|---|
| Every account must use an authenticator app (two-step verification). The database refuses all patient data without it, even if the app is bypassed. | `public.mfa_verified()` in the migration; `renderMfaEnroll` in `web/src/main.ts` |
| Each agency sees only its own data (row level security on every table). | Policies in `supabase/migrations/…_init.sql`; tested in `supabase/tests/rls_test.sql` |
| Minimum necessary access: staff work referrals; only owners and admins edit the profile, manage the team and read the activity log. | Same policies |
| Audit trail of who added, changed and **viewed** referrals, and who ran Claude on one. It stores field names only, never patient details, and cannot be edited or deleted from the app. | `audit_row_change`, `log_access`, `audit_log` policies |
| Referrals cannot be deleted, moved to another agency, or changed after a decision. | `referrals_guard` trigger |
| Encryption in transit (HTTPS/TLS everywhere) and at rest (Supabase encrypts storage). | Platform |
| Automatic sign-out after 15 minutes without activity; sessions end when the tab closes. | `resetIdle` and `sessionStorage` in `web/src/main.ts` and `web/src/supabase.ts` |
| Claude is called only from the server, with CIS Tech's BAA-covered key. Referral text is never written to server logs. | `supabase/functions/extract-referral/index.ts` |
| The app asks for patient initials, not full names, and Claude is told to return initials only. | Intake form and extraction prompt |
| Browser security headers (content security policy, HSTS, no caching). | `web/public/_headers` |

## 4. Policies and paperwork CIS Tech needs

- [ ] **Security risk assessment** (required by the HIPAA Security Rule). Repeat yearly and after major changes.
- [ ] Name a **privacy officer** and a **security officer** (can be the same person at a small company).
- [ ] Written policies: access control, workforce security, contingency and backup, device and media, audit log review, incident response, breach notification (60-day notice rule).
- [ ] **Workforce training** on HIPAA at hire and yearly; keep sign-in sheets.
- [ ] **Audit log review**: someone reviews the Activity log on a schedule (for example monthly) and documents it.
- [ ] **Retention**: decide how long referrals are kept and how they are disposed of. HIPAA documentation must be kept six years.
- [ ] **Vendor list** with each business associate and the date its BAA was signed.

## 5. Before go-live

- [ ] Penetration test or security review by an outside firm.
- [ ] Restore a backup to a test project to confirm backups work.
- [ ] Run `scripts/test-db.sh` and confirm all checks pass.
- [ ] Replace `YOUR-PROJECT` in `web/public/_headers` with the real Supabase project ref.
