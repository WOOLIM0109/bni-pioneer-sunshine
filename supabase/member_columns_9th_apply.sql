-- 0-B. MANUAL APPLY ONLY. First run member_columns_9th_preview.sql and inspect
-- its final 32-row comparison. Never run this file automatically during deploy.
-- Original backups remain untouched, including the deleted 김철홍 row.
begin;
set local lock_timeout='10s';
lock table public.members in share row exclusive mode;
lock table public.member_accounts,private.member_details,private.member_interviews,
  private.member_interview_reviews,public.member_synergy_links in share row exclusive mode;
lock table private.members_backup_20260929,private.collab_9th_backup_meta,private.collab_9th_function_backup in share row exclusive mode;

do $$
declare kim uuid;
begin
  if not exists(select 1 from private.collab_9th_backup_meta where singleton and applied_at is null and rolled_back_at is null)
     or (select count(*) from private.members_backup_20260929)<>33
     or (select count(*) from public.members)<>33 then
    raise exception '미리보기 백업이 없거나 이미 실행했습니다. 0-A 결과를 먼저 확인하세요.';
  end if;
  if exists(
    select 1 from public.members m full join private.members_backup_20260929 b using(id)
    where m.id is null or b.id is null
      or (jsonb_build_object('chapter_role',null)||to_jsonb(m)) is distinct from
         (jsonb_build_object('chapter_role',null)||to_jsonb(b))
  ) then
    raise exception '미리보기 이후 멤버 정보가 변경되었습니다. 실행을 중단했습니다. 기존 백업을 보존하고 변경분을 먼저 확인하세요.';
  end if;
  if (select count(*) from private.collab_9th_function_backup)<>5 or exists(
    select 1 from private.collab_9th_function_backup b
    where to_regprocedure(b.signature) is null or pg_get_functiondef(to_regprocedure(b.signature)) is distinct from b.definition
  ) then
    raise exception '미리보기 이후 관련 DB 함수가 변경되었습니다. 기존 백업을 보존하고 SQL 변경 내용을 먼저 확인하세요.';
  end if;
  if (select count(*) from public.members where name='김철홍')<>1
     or (select count(*) from public.members where name<>'김철홍')<>32
     or exists(select 1 from public.members where name in ('이은성','이서원'))
     or exists(select 1 from public.members m where nullif(to_jsonb(m)->>'chapter_role','') is not null) then
    raise exception '이동 32명·김철홍 1명·이은성 미등록 조건과 다릅니다. 다시 확인하세요.';
  end if;
  select id into kim from public.members where name='김철홍';
  if exists(select 1 from public.member_accounts where member_id=kim or requested_member_id=kim)
     or exists(select 1 from private.member_details where member_id=kim)
     or exists(select 1 from private.member_interviews where member_id=kim)
     or exists(select 1 from private.member_interview_reviews where member_id=kim)
     or exists(select 1 from public.member_synergy_links where source_member_id=kim or target_member_id=kim) then
    raise exception '김철홍에게 연결된 계정·소개·인터뷰·검토·상생 연결이 생겼습니다. 삭제하지 않고 중단했습니다.';
  end if;
end $$;

alter table public.members add column if not exists chapter_role text;
update public.members m set
  name=case when b.name='이 훈' then '이훈' else b.name end,
  chapter_role=case when b.name='권두현' then null else nullif(btrim(b.company),'') end,
  company=b.field,field=b.team,team='미정'
from private.members_backup_20260929 b where m.id=b.id and b.name<>'김철홍';
delete from public.members where name='김철홍';
with added as (
  insert into public.members(name,company,field,team,chapter_role,is_new,sort_order)
  select '이은성','밝은소리라이프','기업행사, MC','미정',null,true,coalesce(max(sort_order),0)+1 from public.members
  returning id
)
update private.collab_9th_backup_meta set applied_at=clock_timestamp(),new_member_id=(select id from added) where singleton;

-- Old pages may continue READING team until the new website deploys, but their
-- obsolete four-column paste and team edits must not shift the data again.
create or replace function private.guard_member_management()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    if exists(select 1 from public.member_accounts where member_id=old.id) then
      raise exception using errcode='P0001',message='계정과 연결된 멤버입니다. 권한 관리에서 해당 계정을 읽기로 바꾼 뒤 삭제하세요.';
    end if;
    return old;
  end if;
  if auth.uid() is not null and ((tg_op='INSERT' and new.team<>'미정') or
    (tg_op='UPDATE' and new.team is distinct from old.team)) then
    raise exception using errcode='42501',message='기존 파워팀 입력은 종료되었습니다. 새로고침한 뒤 협업팀 관리와 새 경청표 순서를 이용하세요.';
  end if;
  if tg_op='UPDATE' and auth.uid() is not null and not private.is_member_admin() and (
    new.id is distinct from old.id or new.sort_order is distinct from old.sort_order
    or new.is_new is distinct from old.is_new or new.is_real is distinct from old.is_real
    or new.chapter_role is distinct from old.chapter_role) then
    raise exception using errcode='42501',message='역할·멤버 구분·순서는 관리자만 변경할 수 있습니다. 본인 소개 항목만 수정하세요.';
  end if;
  return new;
end $$;
revoke all on function private.guard_member_management() from public,anon,authenticated;
drop trigger if exists members_management_guard on public.members;
create trigger members_management_guard before insert or update or delete on public.members
for each row execute function private.guard_member_management();
create or replace function private.reject_legacy_member_team_write()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is not null and (tg_op='UPDATE' or
    coalesce(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb->>'x-sunshine-client','')<>'collab9') then
    raise exception using errcode='42501',message='이전 경청표 입력 방식은 종료되었습니다. 페이지를 새로고침한 뒤 새 입력 순서를 확인하세요.';
  end if;
  return new;
end $$;
revoke all on function private.reject_legacy_member_team_write() from public,anon,authenticated;
drop trigger if exists members_legacy_insert_guard on public.members;
create trigger members_legacy_insert_guard before insert on public.members
for each row execute function private.reject_legacy_member_team_write();
drop trigger if exists members_legacy_team_guard on public.members;
create trigger members_legacy_team_guard before update of team on public.members
for each row execute function private.reject_legacy_member_team_write();
grant select(chapter_role) on public.members to anon,authenticated;

do $$ begin
  if (select count(*) from public.members)<>33
    or exists(select 1 from public.members where name in ('김철홍','이서원','이 훈'))
    or not exists(select 1 from private.members_backup_20260929 where name='김철홍')
    or (select count(*) from public.members where name='이은성' and company='밝은소리라이프' and field='기업행사, MC' and is_new)<>1
    or exists(select 1 from public.members m join private.members_backup_20260929 b using(id)
      where b.name<>'김철홍' and (m.company is distinct from b.field or m.field is distinct from b.team
        or m.team<>'미정' or m.chapter_role is distinct from case when b.name='권두현' then null else nullif(btrim(b.company),'') end)) then
    raise exception '변환 후 검산 실패: 전체 변경을 취소합니다.';
  end if;
end $$;
notify pgrst,'reload schema';
commit;
select name,company,field,chapter_role from public.members order by sort_order,name;
