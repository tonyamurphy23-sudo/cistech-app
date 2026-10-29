# CIS Tech Referral Desk

Referral intake for small home health agencies, hospices and nursing homes.
A referral arrives, Claude reads it, it's checked against what the agency can
actually take on, and the team answers within 15 minutes.

Built on Supabase (database, sign-in, edge functions) with a Vite web app.
See [docs/HIPAA-CHECKLIST.md](docs/HIPAA-CHECKLIST.md) before storing any
real patient information.

## What's here

```
supabase/
  migrations/…_init.sql        tables, row level security, audit trail
  functions/extract-referral   Claude reads a pasted referral (server side)
  functions/invite-member      owners and admins invite teammates
  functions/_shared            service/payer catalog and helpers
  tests/rls_test.sql           access rule tests
web/                           the app (sign-in, two-step verification, queue, intake, profile, team, activity log)
scripts/test-db.sh             runs the migration and access tests on a throwaway Postgres
scripts/check-functions.sh     type-checks the edge functions
docs/HIPAA-CHECKLIST.md        agreements, settings and policies needed for HIPAA
```

## Set up Supabase

1. Create a Supabase project on the **Team plan with the HIPAA add-on**, and sign the BAA (see the checklist).
2. Install the [Supabase CLI](https://supabase.com/docs/guides/cli) and link the project:
   ```sh
   supabase login
   supabase link --project-ref YOUR-PROJECT
   supabase db push
   ```
3. Set the function secrets. The Anthropic key must come from CIS Tech's API organization that has a signed BAA:
   ```sh
   supabase secrets set ANTHROPIC_API_KEY=sk-ant-... APP_ORIGIN=https://app.yourdomain.com
   ```
4. Deploy the functions:
   ```sh
   supabase functions deploy extract-referral
   supabase functions deploy invite-member
   ```
5. In the Supabase dashboard: Authentication → URL configuration → set the Site URL to `APP_ORIGIN`; turn on TOTP multi-factor; apply the rest of the checklist settings.

## Run the web app

```sh
cd web
cp .env.example .env.local      # fill in the project URL and anon key
npm install
npm run dev                     # http://localhost:5173
npm run build                   # production files in web/dist
```

Host `web/dist` on Netlify, Cloudflare Pages or Vercel at `APP_ORIGIN`, with
the headers from `web/public/_headers`.

The first person to sign up creates the agency and becomes its owner. They
invite teammates from the Team tab.

## Tests

```sh
cd web && npm test              # recommendation logic
./scripts/test-db.sh            # database access rules (needs local Postgres 15+)
./scripts/check-functions.sh    # edge function type check
```

## Claude

`extract-referral` uses Claude Opus 5.5 (`claude-opus-5-5`) with structured
output, so the fields always match the form. It has server-side fallback
turned on (`fallbacks: "default"`): if the model declines a request for policy
reasons, the API retries it on a fallback model in the same call. Remove the
`betas` and `fallbacks` lines in the function to turn that off.
