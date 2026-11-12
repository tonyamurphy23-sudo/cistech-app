-- Demo requests from the public website (www.cis-tech.ai). Anyone may add one;
-- nobody can read them through the app. The CIS Tech team reads them in the
-- Supabase dashboard (Table Editor) or with the service role.

create table public.demo_requests (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  name        text not null check (char_length(name) between 1 and 120),
  business    text not null check (char_length(business) between 1 and 200),
  email       text not null check (char_length(email) between 3 and 320 and email like '%@%'),
  phone       text check (char_length(phone) <= 40),
  agency_type text check (char_length(agency_type) <= 60),
  agency_size text check (char_length(agency_size) <= 60),
  message     text check (char_length(message) <= 2000),
  status      text not null default 'new' check (status in ('new', 'contacted', 'booked', 'closed'))
);

alter table public.demo_requests enable row level security;
revoke all on public.demo_requests from anon, authenticated;
grant insert (name, business, email, phone, agency_type, agency_size, message) on public.demo_requests to anon, authenticated;

create policy "anyone can request a demo" on public.demo_requests
  for insert to anon, authenticated with check (status = 'new');
