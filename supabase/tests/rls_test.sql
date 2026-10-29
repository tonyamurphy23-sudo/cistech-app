-- Access rule tests. Run with scripts/test-db.sh. Any failed check raises and
-- stops the run; the last line printed is "ALL CHECKS PASSED".

\set ON_ERROR_STOP on

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'owner-a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'owner-b@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'staff-a@example.test');

create function pg_temp.act_as(p_user text, p_aal text) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', p_user, 'aal', p_aal, 'role', 'authenticated')::text, false);
$$;

create function pg_temp.check(p_ok boolean, p_what text) returns void language plpgsql as $$
begin
  if not coalesce(p_ok, false) then raise exception 'FAILED: %', p_what; end if;
  raise notice 'ok: %', p_what;
end;
$$;

create function pg_temp.fails(p_sql text) returns boolean language plpgsql as $$
begin
  execute p_sql;
  return false;
exception when others then
  return true;
end;
$$;

grant execute on all functions in schema pg_temp to authenticated;

set role authenticated;

-- Without two-step verification nothing works.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal1');
select pg_temp.check(pg_temp.fails($q$ select public.create_agency('Agency A', 'home_health') $q$),
  'cannot create an agency without two-step verification');

-- Owners A and B each create an agency.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
select set_config('test.agency_a', public.create_agency('Agency A', 'home_health')::text, false);
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b', 'aal2');
select set_config('test.agency_b', public.create_agency('Agency B', 'hospice')::text, false);

-- A adds a referral and edits the profile.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
insert into public.referrals (agency_id, patient_initials, diagnosis, needs, payer, location, status, responded_at)
values (current_setting('test.agency_a')::uuid, 'R.M.', 'CHF', '{skilled_nursing}', 'medicare', 'Franklin County', 'accepted', now());
select pg_temp.check((select status = 'open' and responded_at is null from public.referrals limit 1),
  'new referrals always start open, whatever the client sends');
update public.facility_profiles set open_slots = 3, services = '{skilled_nursing}'
  where agency_id = current_setting('test.agency_a')::uuid;
select pg_temp.check((select open_slots = 3 from public.facility_profiles), 'owner can edit the profile');

-- B cannot see or touch A's data.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000b', 'aal2');
select pg_temp.check((select count(*) = 0 from public.referrals), 'another agency sees none of A''s referrals');
select pg_temp.check((select count(*) = 1 from public.agencies), 'another agency sees only its own agency');
select pg_temp.check(pg_temp.fails(format($q$ insert into public.referrals (agency_id, diagnosis) values (%L, 'x') $q$,
  current_setting('test.agency_a'))), 'another agency cannot add referrals to A');
update public.referrals set diagnosis = 'tampered';
update public.facility_profiles set open_slots = 99 where agency_id = current_setting('test.agency_a')::uuid;
select pg_temp.check(pg_temp.fails(format($q$ select public.log_access(%L, '{}', 'queue') $q$,
  current_setting('test.agency_a'))), 'another agency cannot write to A''s access log');

-- A's data is unchanged by B's attempts.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
select pg_temp.check((select diagnosis = 'CHF' from public.referrals), 'B''s update did not reach A''s referral');
select pg_temp.check((select open_slots = 3 from public.facility_profiles), 'B''s update did not reach A''s profile');

-- A signed in without two-step verification sees nothing.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal1');
select pg_temp.check((select count(*) = 0 from public.referrals), 'no data without two-step verification');

-- Deciding a referral records who and when, and locks it.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
update public.referrals set status = 'accepted', reply_text = 'We can accept.';
select pg_temp.check((select responded_by = '00000000-0000-0000-0000-00000000000a' and responded_at is not null from public.referrals),
  'decision records who answered and when');
select pg_temp.check(pg_temp.fails($q$ update public.referrals set status = 'declined' $q$),
  'a decided referral cannot be changed');
select pg_temp.check(pg_temp.fails($q$ delete from public.referrals $q$), 'referrals cannot be deleted');
select pg_temp.check(pg_temp.fails(format($q$ update public.referrals set agency_id = %L $q$, current_setting('test.agency_b'))),
  'a referral cannot be moved to another agency');

-- Staff: can work referrals, cannot edit the profile or read the audit log.
reset role;
insert into public.memberships (agency_id, user_id, role)
values (current_setting('test.agency_a')::uuid, '00000000-0000-0000-0000-0000000000c1', 'staff');
set role authenticated;
select pg_temp.act_as('00000000-0000-0000-0000-0000000000c1', 'aal2');
select pg_temp.check((select count(*) = 1 from public.referrals), 'staff see their agency''s referrals');
update public.facility_profiles set open_slots = 0;
select pg_temp.check((select open_slots = 3 from public.facility_profiles), 'staff cannot edit the profile');
select pg_temp.check((select count(*) = 0 from public.audit_log), 'staff cannot read the audit log');
select public.log_access(current_setting('test.agency_a')::uuid, array(select id from public.referrals), 'queue');
select pg_temp.check(pg_temp.fails($q$ delete from public.memberships where role = 'owner' $q$) or
  (select count(*) = 2 from public.memberships), 'staff cannot remove the owner');

-- Owner reads a complete audit trail that contains no patient details.
select pg_temp.act_as('00000000-0000-0000-0000-00000000000a', 'aal2');
select pg_temp.check((select count(*) filter (where action = 'view') = 1 from public.audit_log), 'views are logged');
select pg_temp.check((select bool_and(fields is null or not (fields && array['R.M.', 'CHF'])) from public.audit_log),
  'audit log holds field names, not patient details');
select pg_temp.check((select fields @> array['reply_text', 'status'] from public.audit_log
                      where action = 'update' and table_name = 'referrals' order by id desc limit 1),
  'audit log lists which fields changed');
select pg_temp.check(pg_temp.fails($q$ delete from public.audit_log $q$), 'audit log cannot be deleted');
select pg_temp.check(pg_temp.fails($q$ insert into public.audit_log (action) values ('fake') $q$), 'audit log cannot be forged');

update public.agencies set name = name;
select pg_temp.check((select count(*) = 0 from public.audit_log where table_name = 'agencies' and action = 'update'),
  'an update that changes nothing is not logged');

select 'ALL CHECKS PASSED' as result;
