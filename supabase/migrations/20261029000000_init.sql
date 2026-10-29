-- CIS Tech core schema.
--
-- Every row belongs to an agency. Row level security limits each table to
-- members of that agency who signed in with multi-factor authentication
-- (JWT aal = 'aal2'). The audit log records who touched what, never the
-- values themselves, so it holds no patient information.

create type public.member_role as enum ('owner', 'admin', 'staff');
create type public.provider_type as enum ('home_health', 'hospice', 'snf');
create type public.referral_status as enum ('open', 'accepted', 'declined');

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.agencies (
  id            uuid primary key default gen_random_uuid(),
  name          text not null check (char_length(name) between 1 and 200),
  provider_type public.provider_type not null default 'home_health',
  created_at    timestamptz not null default now()
);

create table public.memberships (
  agency_id  uuid not null references public.agencies (id) on delete cascade,
  user_id    uuid not null references auth.users (id) on delete cascade,
  role       public.member_role not null default 'staff',
  email      text check (char_length(email) <= 320),
  created_at timestamptz not null default now(),
  primary key (agency_id, user_id)
);
create index memberships_user_idx on public.memberships (user_id);

create table public.facility_profiles (
  agency_id    uuid primary key references public.agencies (id) on delete cascade,
  open_slots   integer not null default 0 check (open_slots >= 0),
  service_area text[] not null default '{}',
  services     text[] not null default '{}',
  payers       text[] not null default '{}',
  updated_at   timestamptz not null default now(),
  updated_by   uuid references auth.users (id)
);

create table public.referrals (
  id               uuid primary key default gen_random_uuid(),
  agency_id        uuid not null references public.agencies (id) on delete restrict,
  received_at      timestamptz not null default now(),
  source           text check (char_length(source) <= 300),
  source_contact   text check (char_length(source_contact) <= 300),
  patient_initials text check (char_length(patient_initials) <= 10),
  age              integer check (age between 0 and 130),
  diagnosis        text check (char_length(diagnosis) <= 1000),
  needs            text[] not null default '{}',
  payer            text,
  location         text check (char_length(location) <= 200),
  start_date       date,
  notes            text check (char_length(notes) <= 2000),
  raw_text         text check (char_length(raw_text) <= 20000),
  status           public.referral_status not null default 'open',
  recommendation   jsonb,
  reply_text       text check (char_length(reply_text) <= 4000),
  responded_at     timestamptz,
  responded_by     uuid references auth.users (id),
  created_by       uuid not null default auth.uid() references auth.users (id),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index referrals_queue_idx on public.referrals (agency_id, status, received_at);

create table public.audit_log (
  id         bigint generated always as identity primary key,
  at         timestamptz not null default now(),
  actor      uuid,
  agency_id  uuid,
  action     text not null,
  table_name text,
  record_ids uuid[],
  fields     text[]
);
create index audit_log_agency_idx on public.audit_log (agency_id, at desc);

-- ---------------------------------------------------------------------------
-- Access helpers
-- ---------------------------------------------------------------------------

create function public.mfa_verified() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
$$;

-- security definer so policies on memberships can call it without recursing.
create function public.member_role_in(p_agency uuid) returns public.member_role
language sql stable security definer set search_path = '' as $$
  select m.role from public.memberships m
  where m.agency_id = p_agency and m.user_id = (select auth.uid())
$$;

create function public.can_access(p_agency uuid) returns boolean
language sql stable set search_path = '' as $$
  select public.mfa_verified() and public.member_role_in(p_agency) is not null
$$;

create function public.can_manage(p_agency uuid) returns boolean
language sql stable set search_path = '' as $$
  select public.mfa_verified() and public.member_role_in(p_agency) in ('owner', 'admin')
$$;

-- ---------------------------------------------------------------------------
-- Audit trail (field names only, never values)
-- ---------------------------------------------------------------------------

create function public.audit_row_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb := case when tg_op <> 'DELETE' then to_jsonb(new) end;
  v_old jsonb := case when tg_op <> 'INSERT' then to_jsonb(old) end;
  v_row jsonb := coalesce(v_new, v_old);
  v_fields text[];
begin
  if tg_op = 'UPDATE' then
    select array_agg(k order by k) into v_fields
    from jsonb_object_keys(v_new) k
    where v_new -> k is distinct from v_old -> k;
  end if;

  insert into public.audit_log (actor, agency_id, action, table_name, record_ids, fields)
  values (
    (select auth.uid()),
    coalesce((v_row ->> 'agency_id')::uuid, (v_row ->> 'id')::uuid),
    lower(tg_op),
    tg_table_name,
    case when v_row ? 'id' then array[(v_row ->> 'id')::uuid] end,
    v_fields
  );
  return null;
end;
$$;

create trigger audit_agencies after insert or update or delete on public.agencies
  for each row execute function public.audit_row_change();
create trigger audit_memberships after insert or update or delete on public.memberships
  for each row execute function public.audit_row_change();
create trigger audit_facility_profiles after insert or update or delete on public.facility_profiles
  for each row execute function public.audit_row_change();
create trigger audit_referrals after insert or update or delete on public.referrals
  for each row execute function public.audit_row_change();

-- Called by the app when referrals are shown on screen, so reads are logged too.
create function public.log_access(p_agency uuid, p_record_ids uuid[], p_context text)
returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not public.can_access(p_agency) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  insert into public.audit_log (actor, agency_id, action, table_name, record_ids, fields)
  values ((select auth.uid()), p_agency, 'view', 'referrals', p_record_ids[1:500], array[left(p_context, 50)]);
end;
$$;

-- ---------------------------------------------------------------------------
-- Referral integrity
-- ---------------------------------------------------------------------------

create function public.referrals_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.status := 'open';
    new.responded_at := null;
    new.responded_by := null;
    new.received_at := coalesce(new.received_at, now());
    if (select auth.uid()) is not null then
      new.created_by := (select auth.uid());
    end if;
    return new;
  end if;

  if new.agency_id is distinct from old.agency_id
     or new.created_by is distinct from old.created_by
     or new.received_at is distinct from old.received_at then
    raise exception 'agency, creator and received time cannot change' using errcode = '42501';
  end if;

  if old.status <> 'open' and new.status is distinct from old.status then
    raise exception 'a decided referral cannot be reopened or changed' using errcode = '42501';
  end if;

  if old.status = 'open' and new.status <> 'open' then
    new.responded_at := now();
    new.responded_by := (select auth.uid());
  else
    new.responded_at := old.responded_at;
    new.responded_by := old.responded_by;
  end if;

  new.updated_at := now();
  return new;
end;
$$;

create trigger referrals_guard before insert or update on public.referrals
  for each row execute function public.referrals_guard();

create function public.profiles_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.agency_id := old.agency_id;
  new.updated_at := now();
  new.updated_by := (select auth.uid());
  return new;
end;
$$;

create trigger facility_profiles_touch before update on public.facility_profiles
  for each row execute function public.profiles_touch();

-- ---------------------------------------------------------------------------
-- Creating an agency (the only way agencies, owners and profiles are made)
-- ---------------------------------------------------------------------------

create function public.create_agency(p_name text, p_type public.provider_type)
returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if (select auth.uid()) is null or not public.mfa_verified() then
    raise exception 'sign in with two-step verification first' using errcode = '42501';
  end if;
  insert into public.agencies (name, provider_type) values (p_name, p_type) returning id into v_id;
  insert into public.memberships (agency_id, user_id, role, email)
  values (v_id, (select auth.uid()), 'owner', (select auth.jwt()) ->> 'email');
  insert into public.facility_profiles (agency_id) values (v_id);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.agencies          enable row level security;
alter table public.memberships       enable row level security;
alter table public.facility_profiles enable row level security;
alter table public.referrals         enable row level security;
alter table public.audit_log         enable row level security;

revoke all on public.agencies, public.memberships, public.facility_profiles,
              public.referrals, public.audit_log from anon, authenticated;

grant select, update on public.agencies to authenticated;
grant select, update, delete on public.memberships to authenticated;
grant select, update on public.facility_profiles to authenticated;
grant select, insert, update on public.referrals to authenticated;
grant select on public.audit_log to authenticated;

revoke execute on function public.create_agency(text, public.provider_type) from public, anon;
revoke execute on function public.log_access(uuid, uuid[], text) from public, anon;
grant execute on function public.create_agency(text, public.provider_type) to authenticated;
grant execute on function public.log_access(uuid, uuid[], text) to authenticated;

create policy "members read their agency" on public.agencies
  for select to authenticated using (public.can_access(id));
create policy "managers rename their agency" on public.agencies
  for update to authenticated using (public.can_manage(id)) with check (public.can_manage(id));

create policy "members see their team" on public.memberships
  for select to authenticated using (public.can_access(agency_id));
create policy "managers change roles" on public.memberships
  for update to authenticated
  using (public.can_manage(agency_id) and user_id <> (select auth.uid())
         and (role <> 'owner' or public.member_role_in(agency_id) = 'owner'))
  with check (role <> 'owner' or public.member_role_in(agency_id) = 'owner');
create policy "managers remove members" on public.memberships
  for delete to authenticated
  using (public.can_manage(agency_id) and user_id <> (select auth.uid())
         and (role <> 'owner' or public.member_role_in(agency_id) = 'owner'));

create policy "members read the profile" on public.facility_profiles
  for select to authenticated using (public.can_access(agency_id));
create policy "managers edit the profile" on public.facility_profiles
  for update to authenticated using (public.can_manage(agency_id)) with check (public.can_manage(agency_id));

create policy "members read referrals" on public.referrals
  for select to authenticated using (public.can_access(agency_id));
create policy "members add referrals" on public.referrals
  for insert to authenticated with check (public.can_access(agency_id));
create policy "members decide referrals" on public.referrals
  for update to authenticated using (public.can_access(agency_id)) with check (public.can_access(agency_id));

create policy "managers read the audit log" on public.audit_log
  for select to authenticated using (public.can_manage(agency_id));

-- Live queue updates (Supabase Realtime honors the policies above).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.referrals;
  end if;
end;
$$;
