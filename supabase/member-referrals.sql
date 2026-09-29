-- Rerunnable setup: run after schema.sql / roles.sql and interviews.sql.
-- Referral guidance is shared with approved, confirmed chapter members.
-- Company names, source documents, draft proposals and write permissions retain
-- their existing scope. Read the existing values; do not copy or migrate data.
begin;

create or replace function private.get_member_referrals(target_member_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if auth.uid() is null or not (
    private.is_member_admin() or exists (
      select 1 from public.member_accounts a
      join auth.users u on u.id=a.user_id
      where a.user_id=auth.uid() and a.role='member' and a.member_id is not null
        and u.email_confirmed_at is not null and coalesce(u.email,'')<>''
        and not coalesce(u.is_anonymous,false)
    )
  ) then
    raise exception using errcode='42501',message='승인된 멤버와 관리자만 멤버의 소개 정보를 볼 수 있습니다.';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'member_id',m.id,
    'good_referral',coalesce(d.good_referral,''),
    'triggers',coalesce(d.triggers,'{}'::text[])
  ) order by m.sort_order,m.name),'[]'::jsonb) into result
  from public.members m left join private.member_details d on d.member_id=m.id
  where target_member_id is null or m.id=target_member_id;
  return result;
end $$;

create or replace function public.get_member_referrals(target_member_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$
  select private.get_member_referrals(target_member_id);
$$;

revoke all on function private.get_member_referrals(uuid) from public,anon,authenticated;
revoke all on function public.get_member_referrals(uuid) from public,anon,authenticated;
grant execute on function private.get_member_referrals(uuid) to authenticated;
grant execute on function public.get_member_referrals(uuid) to authenticated;

notify pgrst,'reload schema';
commit;
