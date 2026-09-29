-- MANUAL ROLLBACK ONLY. Pause administrative edits / AI analysis first.
-- Restore the previous Edge Function + website release with this DB rollback;
-- the previous website can read while waiting, but old team writes are blocked
-- until this transaction restores its original functions.
-- This restores ALL original member fields (including pre-fix values), removes
-- 이은성 and restores 김철홍. It deliberately keeps every original backup.
-- Additional private backups preserve current member edits and every existing
-- collaboration team, membership, chat link and unresolved name before removal.
begin;
set local lock_timeout='10s';
lock table public.members in share row exclusive mode;
lock table public.member_accounts,private.member_details,private.member_interviews,
  private.member_interview_reviews,public.member_synergy_links in share row exclusive mode;
lock table private.members_backup_20260929,private.collab_9th_backup_meta in share row exclusive mode;

do $$
declare added uuid;
begin
  select new_member_id into added from private.collab_9th_backup_meta
    where singleton and applied_at is not null and rolled_back_at is null;
  if added is null or (select count(*) from private.members_backup_20260929)<>33
    or (select count(*) from private.collab_9th_function_backup)<>5 then
    raise exception '적용 기록/원본 백업이 없거나 이미 롤백했습니다. 중단합니다.';
  end if;
  if not exists(select 1 from public.members where id=added and name='이은성')
    or exists(select 1 from public.members m where m.id<>added and not exists(select 1 from private.members_backup_20260929 b where b.id=m.id))
    or exists(select 1 from private.members_backup_20260929 b where b.name<>'김철홍' and not exists(select 1 from public.members m where m.id=b.id))
    or exists(select 1 from public.members where name='김철홍') then
    raise exception '전환 이후 멤버 등록/삭제/이름이 변경되었습니다. 자동 원상복구 대신 명단을 먼저 확인하세요.';
  end if;
  if exists(select 1 from public.member_accounts where member_id=added or requested_member_id=added)
    or exists(select 1 from private.member_details where member_id=added)
    or exists(select 1 from private.member_interviews where member_id=added)
    or exists(select 1 from private.member_interview_reviews where member_id=added)
    or exists(select 1 from public.member_synergy_links where source_member_id=added or target_member_id=added) then
    raise exception '이은성에게 새 계정·소개·인터뷰·검토·상생 연결이 있습니다. 자료를 보존하기 위해 롤백을 중단했습니다.';
  end if;
  -- Serialize with the editor if the optional collaboration setup was installed.
  if to_regclass('private.collab_team_state') is not null then
    execute 'lock table private.collab_team_state in share row exclusive mode';
  end if;
  if to_regclass('public.collab_teams') is not null then
    execute 'lock table public.collab_teams in share row exclusive mode';
  end if;
  if to_regclass('public.collab_team_members') is not null then
    execute 'lock table public.collab_team_members in share row exclusive mode';
  end if;
end $$;

create table private.members_before_collab_rollback_20260929 as select * from public.members;
alter table private.members_before_collab_rollback_20260929 enable row level security;
revoke all on private.members_before_collab_rollback_20260929 from public,anon,authenticated;

-- Also works when rolling back immediately after 0-B, before collaboration
-- setup exists. No IF NOT EXISTS on backup creation: never overwrite a backup.
do $$
declare item record;
begin
  for item in select * from (values
    ('public.collab_teams','collab_teams_before_collab_rollback_20260929'),
    ('public.collab_team_members','collab_team_members_before_collab_rollback_20260929'),
    ('private.collab_team_state','collab_team_state_before_collab_rollback_20260929')
  ) sources(source_table,backup_table) loop
    if to_regclass(item.source_table) is not null then
      execute format('create table private.%I as select * from %s',item.backup_table,to_regclass(item.source_table));
      execute format('alter table private.%I enable row level security',item.backup_table);
      execute format('revoke all on private.%I from public,anon,authenticated',item.backup_table);
    end if;
  end loop;
end $$;

-- Exact saved pre-upgrade implementations restore legacy team permissions and
-- AI contracts before the new column is removed. Backups are never deleted.
do $$ declare f record; begin
  for f in select definition from private.collab_9th_function_backup order by signature loop
    execute f.definition;
  end loop;
end $$;
drop trigger if exists members_management_guard on public.members;
create trigger members_management_guard before update or delete on public.members
  for each row execute function private.guard_member_management();
drop trigger if exists members_legacy_insert_guard on public.members;
drop trigger if exists members_legacy_team_guard on public.members;
drop function if exists private.reject_legacy_member_team_write();

drop function if exists public.save_collab_teams(bigint,jsonb,jsonb,jsonb);
drop function if exists public.get_collab_team_admin();
drop function if exists public.get_collab_team_chat_links();
drop function if exists private.save_collab_teams(bigint,jsonb,jsonb,jsonb);
drop function if exists private.get_collab_team_admin();
drop function if exists private.get_collab_team_chat_links();
alter table if exists public.collab_teams drop constraint if exists collab_team_leader_is_member;
drop table if exists public.collab_team_members;
drop table if exists public.collab_teams;
drop table if exists private.collab_team_state;

delete from public.members where id=(select new_member_id from private.collab_9th_backup_meta where singleton);
-- Preserve the original audit fields as well; only the timestamp trigger is
-- temporarily disabled inside this locked transaction, never permission guards.
alter table public.members disable trigger members_touch;
do $$
declare columns_sql text; assignments_sql text;
begin
  select string_agg(format('%I',attname),',' order by attnum),
    string_agg(format('%I=excluded.%I',attname,attname),',' order by attnum) filter(where attname<>'id')
    into columns_sql,assignments_sql
  from pg_attribute where attrelid='private.members_backup_20260929'::regclass and attnum>0 and not attisdropped;
  execute format('insert into public.members(%s) select %s from private.members_backup_20260929 on conflict(id) do update set %s',columns_sql,columns_sql,assignments_sql);
  if not (select had_chapter_role from private.collab_9th_backup_meta where singleton) then
    alter table public.members drop column chapter_role;
  end if;
end $$;
alter table public.members enable trigger members_touch;
do $$ begin
  if exists(select 1 from public.members m full join private.members_backup_20260929 b using(id)
    where m.id is null or b.id is null or to_jsonb(m) is distinct from to_jsonb(b)) then
    raise exception '원본 백업과 복원 결과가 다릅니다. 전체 롤백 작업을 취소합니다.';
  end if;
end $$;
update private.collab_9th_backup_meta set rolled_back_at=clock_timestamp() where singleton;
notify pgrst,'reload schema';
commit;
select (select count(*) from public.members) as restored_members,
  (select count(*) from private.members_backup_20260929) as original_backup_rows,
  (select count(*) from private.members_before_collab_rollback_20260929) as pre_rollback_backup_rows;
