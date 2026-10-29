-- Don't write an audit entry for an update that changed nothing.
create or replace function public.audit_row_change() returns trigger
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
    where v_new -> k is distinct from v_old -> k
      and k not in ('updated_at', 'updated_by');
    if v_fields is null then
      return null;
    end if;
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
