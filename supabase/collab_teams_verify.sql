-- READ ONLY. Run the numbered SELECT blocks individually in Supabase SQL Editor.
-- Expected results describe the initial ninth-cohort roster, before later edits.

-- 1. After member_columns_9th_apply.sql: 33 / 1 / 33 / 0 / 1 / 0 / 1 / 0.
select
  (select count(*) from private.members_backup_20260929) as backup_members,
  (select count(*) from private.members_backup_20260929 where name='김철홍') as kim_in_backup,
  count(*) as current_members,
  count(*) filter(where name='김철홍') as kim_current,
  count(*) filter(where name='이은성') as eunseong_current,
  count(*) filter(where regexp_replace(name,'\s','','g')='이서원') as seowon_current,
  count(*) filter(where name='이훈') as normalized_hoon,
  count(*) filter(where name='이 훈') as old_hoon
from public.members;

-- 2. All 32 retained original members must match their approved transformation.
-- Expected: 32 / 32. No private referral or source text is queried.
select count(*) as retained_members,
  count(*) filter(where
    m.name=case when b.name='이 훈' then '이훈' else b.name end
    and m.company=b.field and m.field=b.team
    and m.chapter_role is not distinct from case when b.name='권두현' then null else nullif(btrim(b.company),'') end
    and m.team='미정') as correctly_transformed
from private.members_backup_20260929 b
join public.members m on m.id=b.id
where b.name<>'김철홍';

-- 3. Expected Song: company='앱 개발 · 맞춤형 미니 앱 제작 · 디지털 명함(DiCA)',
-- field='앱,웹개발(디지탈명함)', chapter_role='121마스터'.
-- Kwon: chapter_role IS NULL. Eunseong: 밝은소리라이프 / 기업행사, MC / true.
select name,company,field,chapter_role,is_new
from public.members where name in ('송승훈','권두현','이은성') order by name;

-- 4. After collab_teams.sql: 5 rows, member counts 4 / 10 / 9 / 5 / 5.
select t.sort_order,t.name,l.name as leader,count(tm.member_id) as member_count
from public.collab_teams t
left join public.members l on l.id=t.leader_member_id
left join public.collab_team_members tm on tm.team_id=t.id
group by t.id,t.sort_order,t.name,l.name order by t.sort_order,t.name;

-- 5. Expected initial counts: 33 / 33 / 33 / 0 / 0 / 0.
-- After intentionally adding multiple memberships, membership_total can be larger
-- than total_members; distinct_assigned must still count each member once.
select
  (select count(*) from public.members) as total_members,
  (select count(*) from public.collab_team_members) as membership_total,
  (select count(distinct member_id) from public.collab_team_members) as distinct_assigned,
  (select count(*) from public.members m where not exists(
    select 1 from public.collab_team_members tm where tm.member_id=m.id)) as unassigned_members,
  (select count(*) from (select member_id from public.collab_team_members group by member_id having count(*)>1) multi) as multiple_memberships,
  (select count(*) from public.collab_teams t where t.leader_member_id is not null and not exists(
    select 1 from public.collab_team_members tm where tm.team_id=t.id and tm.member_id=t.leader_member_id)) as invalid_leaders;

-- 6. Expected: 이소연=웰니스 협업팀, 이은성=B2B 기업지원 협업팀.
-- No rows for 이서원 or 김철홍.
select m.name,t.name as collab_team
from public.members m
left join public.collab_team_members tm on tm.member_id=m.id
left join public.collab_teams t on t.id=tm.team_id
where regexp_replace(m.name,'\s','','g') in ('이소연','이은성','이서원','김철홍') order by m.name;

-- 7. Direct chat-link reads must be false for both browser database roles.
select has_column_privilege('anon','public.collab_teams','chat_link','SELECT') as anonymous_chat_read,
  has_column_privilege('authenticated','public.collab_teams','chat_link','SELECT') as direct_member_chat_read,
  to_regprocedure('public.get_collab_team_chat_links()') is not null as chat_rpc_exists;
-- Expected: false / false / true. Authorized chat reads go through the RPC.

-- 8. Expected initial unresolved roster names: 0.
select jsonb_array_length(pending_names) as unresolved_names
from private.collab_team_state where singleton;

-- 9. Operations notice is derived from roles, not hardcoded member names.
-- Expected five members: 심학봉 / 김경태 / 송승훈 / 이채홍 / 정상현.
select name,chapter_role from public.members
where regexp_replace(chapter_role,'\s','','g') in ('의장','부의장','121마스터','성장코디','ST')
order by name;
