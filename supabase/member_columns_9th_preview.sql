-- 0-A. MANUAL PREVIEW ONLY. Run in Supabase SQL Editor, inspect the final 32 rows,
-- then run member_columns_9th_apply.sql separately only if the mapping is correct.
-- The very first data operation creates an immutable original backup.
-- Deliberately no IF NOT EXISTS: a second execution must not replace the backup.
begin;
create table private.members_backup_20260929 as select * from public.members;
alter table private.members_backup_20260929 enable row level security;
revoke all on private.members_backup_20260929 from public,anon,authenticated;

create table private.collab_9th_backup_meta (
  singleton boolean primary key default true check(singleton),
  created_at timestamptz not null default clock_timestamp(),
  had_chapter_role boolean not null,
  applied_at timestamptz,
  new_member_id uuid,
  rolled_back_at timestamptz
);
insert into private.collab_9th_backup_meta(singleton,had_chapter_role)
select true,exists(select 1 from pg_attribute where attrelid='public.members'::regclass and attname='chapter_role' and not attisdropped);
alter table private.collab_9th_backup_meta enable row level security;
revoke all on private.collab_9th_backup_meta from public,anon,authenticated;

-- Exact pre-upgrade function bodies are used by the manual rollback; no guesses.
create table private.collab_9th_function_backup as
select p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid=p.pronamespace
where n.nspname='private' and p.proname in
 ('guard_member_management','validate_member_patch','validate_interview_review_analysis','apply_member_interview','apply_member_interview_review');
alter table private.collab_9th_function_backup add primary key(signature);
alter table private.collab_9th_function_backup enable row level security;
revoke all on private.collab_9th_function_backup from public,anon,authenticated;

do $$
declare expected text[]:=array['마루이','윤민수','이화춘','심학봉','박선영','권두현','이상호','정명수','박진성','김지현','조은영','오예준','조진성','박병준','송승훈','조현우','김근우','박미성','홍정택','이도현','이해경','박지형','이채홍','김경태','정상현','이훈','이소연','임춘식','김윤호','이수민','문성우','최경수'];
begin
  if (select count(*) from private.members_backup_20260929)<>33
     or (select count(*) from private.members_backup_20260929 where name='김철홍')<>1
     or exists(select 1 from private.members_backup_20260929 where name in ('이은성','이서원'))
     or exists(select 1 from unnest(expected) e(name) where (select count(*) from private.members_backup_20260929 b where replace(b.name,' ','')=e.name)<>1)
     or exists(select 1 from private.members_backup_20260929 b where b.name<>'김철홍' and not replace(b.name,' ','')=any(expected)) then
    raise exception '예상한 기존 33명(이동 32명 + 김철홍 1명)과 다릅니다. 원본 명단을 다시 확인하세요.';
  end if;
  if exists(select 1 from private.members_backup_20260929 b where nullif(to_jsonb(b)->>'chapter_role','') is not null)
     or (select count(*) from private.collab_9th_function_backup)<>5
     or to_regclass('public.collab_teams') is not null then
    raise exception '이미 전환했거나 예상한 사전 구조와 다릅니다. 백업을 덮어쓰지 말고 확인하세요.';
  end if;
end $$;
commit;

-- FINAL RESULT: compare every affected row, not only a single example.
select id,
  name as before_name,case when name='이 훈' then '이훈' else name end as after_name,
  company as before_company,field as after_company,
  field as before_field,team as after_field,
  to_jsonb(b)->>'chapter_role' as before_chapter_role,
  case when name='권두현' then null else nullif(btrim(company),'') end as after_chapter_role
from private.members_backup_20260929 b
where name<>'김철홍'
order by sort_order,name;
