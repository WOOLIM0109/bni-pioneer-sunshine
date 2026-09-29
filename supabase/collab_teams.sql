-- MANUAL upgrade/setup. Existing installation: inspect 0-A preview, run 0-B
-- apply, then run THIS file before deploying the matching Edge Function + UI.
-- Rerunnable: initial roster is seeded once; later administrator edits survive.
-- chat_link must NEVER be added to the public SELECT list or Realtime payload.
begin;
alter table public.members add column if not exists chapter_role text;
grant select(chapter_role) on public.members to anon,authenticated;

create table if not exists public.collab_teams (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check(char_length(btrim(name)) between 1 and 100),
  sort_order int not null default 0 check(sort_order>=0),
  leader_member_id uuid references public.members(id) on delete set null,
  chat_link text not null default '' check(chat_link='' or (char_length(chat_link)<=2048 and chat_link ~ '^https://[^[:space:]<>]+$')),
  note text not null default '' check(char_length(note)<=5000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
create table if not exists public.collab_team_members (
  team_id uuid not null references public.collab_teams(id) on delete cascade,
  member_id uuid not null references public.members(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  primary key(team_id,member_id)
);
create index if not exists collab_team_members_member_idx on public.collab_team_members(member_id,team_id);
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.collab_teams'::regclass and conname='collab_team_leader_is_member') then
    alter table public.collab_teams add constraint collab_team_leader_is_member
      foreign key(id,leader_member_id) references public.collab_team_members(team_id,member_id)
      deferrable initially deferred;
  end if;
end $$;
create table if not exists private.collab_team_state (
  singleton boolean primary key default true check(singleton),
  revision bigint not null default 1 check(revision>0),
  seeded boolean not null default false,
  pending_names jsonb not null default '[]' check(jsonb_typeof(pending_names)='array')
);
insert into private.collab_team_state(singleton) values(true) on conflict do nothing;
alter table public.collab_teams enable row level security;
alter table public.collab_team_members enable row level security;
alter table private.collab_team_state enable row level security;
revoke all on public.collab_teams,public.collab_team_members,private.collab_team_state from public,anon,authenticated;
-- Explicit column grants also prevent select=* and direct chat_link reads.
grant select(id,name,sort_order,leader_member_id,note,created_at,updated_at) on public.collab_teams to anon,authenticated;
grant select on public.collab_team_members to anon,authenticated;
grant select,insert,update,delete on public.collab_teams,public.collab_team_members,private.collab_team_state to service_role;
drop policy if exists collab_teams_read on public.collab_teams;
create policy collab_teams_read on public.collab_teams for select to anon,authenticated using(true);
drop policy if exists collab_team_members_read on public.collab_team_members;
create policy collab_team_members_read on public.collab_team_members for select to anon,authenticated using(true);

-- Private pending names preserve unresolved roster entries without registering
-- imaginary members. Duplicate names are unresolved too: never guess a UUID.
do $$
declare item record; member_name text; member_uuid uuid; leader_uuid uuid;
  pending jsonb:='[]';
begin
  perform 1 from private.collab_team_state where singleton for update;
  if (select seeded from private.collab_team_state where singleton) then return; end if;
  for item in select * from (values
    ('90000000-0000-4000-8000-000000000001'::uuid,'라이프 이벤트 협업팀',1,'마루이',array['마루이','윤민수','이화춘','심학봉']),
    ('90000000-0000-4000-8000-000000000002'::uuid,'부동산&공간 협업팀',2,'박선영',array['박선영','권두현','이상호','정명수','박진성','김지현','조은영','오예준','조진성','박병준']),
    ('90000000-0000-4000-8000-000000000003'::uuid,'B2B 기업지원 협업팀',3,'송승훈',array['송승훈','조현우','김근우','박미성','홍정택','이도현','이해경','박지형','이은성']),
    ('90000000-0000-4000-8000-000000000004'::uuid,'웰니스 협업팀',4,'이채홍',array['이채홍','김경태','정상현','이훈','이소연']),
    ('90000000-0000-4000-8000-000000000005'::uuid,'푸드·기프트&프랜차이즈 협업팀',5,'임춘식',array['임춘식','김윤호','이수민','문성우','최경수'])
  ) roster(id,name,sort_order,leader,names) loop
    insert into public.collab_teams(id,name,sort_order) values(item.id,item.name,item.sort_order);
    leader_uuid:=null;
    foreach member_name in array item.names loop
      if (select count(*) from public.members where name=member_name)=1 then
        select id into member_uuid from public.members where name=member_name;
        insert into public.collab_team_members(team_id,member_id) values(item.id,member_uuid);
        if member_name=item.leader then leader_uuid:=member_uuid; end if;
      else
        pending:=pending||jsonb_build_array(jsonb_build_object('team_id',item.id,'name',member_name));
      end if;
    end loop;
    update public.collab_teams set leader_member_id=leader_uuid where id=item.id;
  end loop;
  update private.collab_team_state set seeded=true,pending_names=pending where singleton;
end $$;

create or replace function private.get_collab_team_admin()
returns jsonb language plpgsql security definer set search_path='' as $$
declare state private.collab_team_state;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if not private.is_member_admin() then raise exception using errcode='42501',message='관리자만 협업팀을 관리할 수 있습니다.'; end if;
  select * into state from private.collab_team_state where singleton for share;
  return jsonb_build_object('revision',state.revision,
    'teams',(select coalesce(jsonb_agg(to_jsonb(t) order by t.sort_order,t.name),'[]') from public.collab_teams t),
    'memberships',(select coalesce(jsonb_agg(jsonb_build_object('team_id',m.team_id,'member_id',m.member_id) order by m.team_id,m.member_id),'[]') from public.collab_team_members m),
    'pending_names',state.pending_names);
end $$;

create or replace function private.get_collab_team_chat_links()
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if auth.uid() is null then raise exception using errcode='42501',message='로그인한 팀원과 관리자만 단톡방을 볼 수 있습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('team_id',t.id,'chat_link',t.chat_link) order by t.sort_order,t.name),'[]') into result
    from public.collab_teams t where t.chat_link<>'' and (
      private.is_member_admin() or exists(
        select 1 from public.member_accounts a join auth.users u on u.id=a.user_id
        join public.collab_team_members tm on tm.member_id=a.member_id and tm.team_id=t.id
        where a.user_id=auth.uid() and a.role='member' and a.member_id is not null
          and u.email_confirmed_at is not null and coalesce(u.email,'')<>'' and not coalesce(u.is_anonymous,false)));
  return result;
end $$;

create or replace function private.save_collab_teams(expected_revision bigint,teams jsonb,memberships jsonb,pending_names jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' as $$
declare current_revision bigint; item jsonb; old_names record;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if not private.is_member_admin() then raise exception using errcode='42501',message='관리자만 협업팀을 저장할 수 있습니다.'; end if;
  select revision into current_revision from private.collab_team_state where singleton for update;
  if expected_revision is null or current_revision<>expected_revision then
    raise exception using errcode='40001',message='협업팀이 다른 곳에서 변경되었습니다. 최신 정보를 다시 불러오세요.';
  end if;
  if teams is null or memberships is null or pending_names is null
    or jsonb_typeof(teams)<>'array' or jsonb_typeof(memberships)<>'array' or jsonb_typeof(pending_names)<>'array'
    or jsonb_array_length(teams)>100 or jsonb_array_length(memberships)>10000 or jsonb_array_length(pending_names)>1000
    or pg_column_size(teams)+pg_column_size(memberships)+pg_column_size(pending_names)>1048576 then
    raise exception using errcode='22023',message='협업팀 저장 형식을 확인하세요.';
  end if;
  for item in select value from jsonb_array_elements(teams) loop
    if jsonb_typeof(item)<>'object' or not item ?& array['id','name','sort_order']
      or jsonb_typeof(item->'id')<>'string' or jsonb_typeof(item->'name')<>'string'
      or char_length(btrim(item->>'name')) not between 1 and 100
      or jsonb_typeof(item->'sort_order')<>'number' or (item->>'sort_order')!~'^[0-9]{1,9}$'
      or (item?'note' and jsonb_typeof(item->'note')<>'string')
      or (item?'chat_link' and jsonb_typeof(item->'chat_link')<>'string')
      or (item?'leader_member_id' and jsonb_typeof(item->'leader_member_id') not in ('string','null')) then
      raise exception using errcode='22023',message='팀 이름·순서·팀장·단톡방 입력을 확인하세요.';
    end if;
    perform (item->>'id')::uuid,(item->>'leader_member_id')::uuid;
  end loop;
  if exists(select 1 from jsonb_array_elements(teams) t group by (t->>'id')::uuid having count(*)>1)
    or exists(select 1 from jsonb_array_elements(teams) t group by btrim(t->>'name') having count(*)>1) then
    raise exception using errcode='22023',message='팀 ID와 이름은 중복할 수 없습니다.';
  end if;
  for item in select value from jsonb_array_elements(memberships) loop
    if jsonb_typeof(item)<>'object' or not item ?& array['team_id','member_id']
       or jsonb_typeof(item->'team_id')<>'string' or jsonb_typeof(item->'member_id')<>'string'
       or not exists(select 1 from jsonb_array_elements(teams) t where (t->>'id')::uuid=(item->>'team_id')::uuid)
       or not exists(select 1 from public.members where id=(item->>'member_id')::uuid) then
      raise exception using errcode='22023',message='등록된 팀과 멤버만 소속시킬 수 있습니다.';
    end if;
  end loop;
  if exists(select 1 from jsonb_array_elements(memberships) m group by (m->>'team_id')::uuid,(m->>'member_id')::uuid having count(*)>1) then
    raise exception using errcode='22023',message='같은 팀의 같은 멤버가 중복되었습니다.';
  end if;
  if exists(select 1 from jsonb_array_elements(teams) t where t->>'leader_member_id' is not null and not exists(
    select 1 from jsonb_array_elements(memberships) m where (m->>'team_id')::uuid=(t->>'id')::uuid and (m->>'member_id')::uuid=(t->>'leader_member_id')::uuid)) then
    raise exception using errcode='22023',message='팀장은 해당 팀에 소속된 멤버 중에서 지정하세요.';
  end if;
  for item in select value from jsonb_array_elements(pending_names) loop
    if jsonb_typeof(item)<>'object' or not item ?& array['team_id','name']
      or jsonb_typeof(item->'team_id')<>'string' or jsonb_typeof(item->'name')<>'string'
      or char_length(btrim(item->>'name')) not between 1 and 100
      or not exists(select 1 from jsonb_array_elements(teams) t where (t->>'id')::uuid=(item->>'team_id')::uuid) then
      raise exception using errcode='22023',message='미등록 명단의 팀과 이름을 확인하세요.';
    end if;
  end loop;
  -- Prevent concurrent member deletion while validating and saving the matrix.
  perform m.id from public.members m where m.id in (select (v->>'member_id')::uuid from jsonb_array_elements(memberships) v) order by m.id for key share;
  -- Temporarily free unique names so two teams may exchange names atomically.
  for old_names in select id from public.collab_teams loop
    update public.collab_teams set name='__collab_'||old_names.id::text where id=old_names.id;
  end loop;
  delete from public.collab_teams where id not in(select (t->>'id')::uuid from jsonb_array_elements(teams) t);
  insert into public.collab_teams(id,name,sort_order,leader_member_id,note,chat_link)
  select (t->>'id')::uuid,btrim(t->>'name'),(t->>'sort_order')::int,(t->>'leader_member_id')::uuid,coalesce(t->>'note',''),coalesce(t->>'chat_link','')
  from jsonb_array_elements(teams) t
  on conflict(id) do update set name=excluded.name,sort_order=excluded.sort_order,leader_member_id=excluded.leader_member_id,
    note=excluded.note,chat_link=excluded.chat_link,updated_at=clock_timestamp();
  delete from public.collab_team_members m where not exists(select 1 from jsonb_array_elements(memberships) v
    where m.team_id=(v->>'team_id')::uuid and m.member_id=(v->>'member_id')::uuid);
  insert into public.collab_team_members(team_id,member_id)
  select (m->>'team_id')::uuid,(m->>'member_id')::uuid from jsonb_array_elements(memberships) m on conflict do nothing;
  update private.collab_team_state set revision=revision+1,pending_names=(
    select coalesce(jsonb_agg(p),'[]') from jsonb_array_elements(save_collab_teams.pending_names) p
    where not ((select count(*) from public.members m where m.name=btrim(p->>'name'))=1
      and exists(select 1 from public.members m join public.collab_team_members tm on tm.member_id=m.id
        where m.name=btrim(p->>'name') and tm.team_id=(p->>'team_id')::uuid))
  ) where singleton;
  return private.get_collab_team_admin();
end $$;

create or replace function public.get_collab_team_admin()
returns jsonb language sql security invoker set search_path='' as $$ select private.get_collab_team_admin(); $$;
create or replace function public.get_collab_team_chat_links()
returns jsonb language sql security invoker set search_path='' as $$ select private.get_collab_team_chat_links(); $$;
create or replace function public.save_collab_teams(expected_revision bigint,teams jsonb,memberships jsonb,pending_names jsonb default '[]')
returns jsonb language sql security invoker set search_path='' as $$ select private.save_collab_teams(expected_revision,teams,memberships,pending_names); $$;
do $$ declare f regprocedure; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname in ('public','private') and p.proname in ('get_collab_team_admin','get_collab_team_chat_links','save_collab_teams') loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
    execute format('grant execute on function %s to authenticated',f);
  end loop;
end $$;

-- Existing interview function replacements are appended below. They preserve
-- source/history records while preventing new AI writes to the retired team.

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

create or replace function private.validate_member_patch(patch jsonb, patch_kind text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb; item jsonb; allowed text[];
begin
  if patch is null or jsonb_typeof(patch)<>'object' or pg_column_size(patch)>1048576 then
    raise exception using errcode='22023', message='저장할 항목은 1MB 이하의 JSON 객체여야 합니다.';
  end if;
  if patch_kind='public' then allowed:=array['name','company','field','customers','synergies','wants','is_new','is_real'];
  elsif patch_kind='private' then allowed:=array['good_referral','triggers','customer_companies'];
  else raise exception using errcode='22023', message='잘못된 저장 구분입니다.'; end if;
  for k,v in select key,value from jsonb_each(patch) loop
    if not k=any(allowed) then raise exception using errcode='22023', message='허용되지 않은 저장 항목입니다: '||k; end if;
    if k=any(array['customers','synergies','triggers','customer_companies']) then
      if jsonb_typeof(v)<>'array' then raise exception using errcode='22023',message=k||' 항목은 문자열 배열이어야 합니다.'; end if;
      if jsonb_array_length(v)>100 then raise exception using errcode='22023',message=k||' 항목은 100개 이하로 입력하세요.'; end if;
      for item in select value from jsonb_array_elements(v) loop
        if jsonb_typeof(item)<>'string' or char_length(item#>>'{}')>1000 then
          raise exception using errcode='22023',message=k||'의 각 값은 1,000자 이하 문자열이어야 합니다.';
        end if;
      end loop;
    elsif k=any(array['is_new','is_real']) then
      if jsonb_typeof(v)<>'boolean' then raise exception using errcode='22023',message=k||' 항목은 true/false여야 합니다.'; end if;
    elsif jsonb_typeof(v)<>'string' or char_length(v#>>'{}')>10000 then
      raise exception using errcode='22023',message=k||' 항목은 10,000자 이하 문자열이어야 합니다.';
    end if;
    if k='name' and btrim(v#>>'{}')='' then raise exception using errcode='22023',message='성함은 비워 둘 수 없습니다.'; end if;
  end loop;
  return patch;
end $$;

create or replace function private.apply_member_interview(target_interview_id uuid, expected_revision bigint,
  expected_member_updated_at timestamptz, public_patch jsonb, private_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interviews; target_id uuid; member_row public.members; stamp timestamptz; detail_revision bigint;
begin
  perform private.require_interview_admin();
  perform private.validate_member_patch(public_patch,'public'); perform private.validate_member_patch(private_patch,'private');
  if public_patch='{}'::jsonb and private_patch='{}'::jsonb then raise exception using errcode='22023',message='반영할 항목을 한 개 이상 선택하세요.'; end if;
  select member_id into target_id from private.member_interviews where id=target_interview_id;
  if not found then raise exception using errcode='22023',message='질문지를 찾을 수 없습니다.'; end if;
  select * into member_row from public.members where id=target_id for update;
  select * into row_value from private.member_interviews where id=target_interview_id for update;
  if expected_revision is null or row_value.revision<>expected_revision or expected_member_updated_at is null
    or member_row.updated_at is distinct from expected_member_updated_at then
    raise exception using errcode='40001',message='질문지 또는 멤버 정보가 변경되었습니다. 최신 내용과 비교한 후 다시 반영하세요.';
  end if;
  if row_value.status='applied' then raise exception using errcode='22023',message='이미 반영한 질문지입니다. 목록에서 결과를 확인하세요.'; end if;
  if row_value.analysis_lease is not null and row_value.analysis_expires_at>clock_timestamp() then
    raise exception using errcode='55000',message='분석 완료 후 검토한 항목을 반영하세요.';
  end if;
  -- Explicit field allowlist. Missing fields retain their current values.
  update public.members set
    name=case when public_patch?'name' then btrim(public_patch->>'name') else name end,
    company=case when public_patch?'company' then public_patch->>'company' else company end,
    field=case when public_patch?'field' then public_patch->>'field' else field end,
    customers=case when public_patch?'customers' then array(select jsonb_array_elements_text(public_patch->'customers')) else customers end,
    synergies=case when public_patch?'synergies' then array(select jsonb_array_elements_text(public_patch->'synergies')) else synergies end,
    wants=case when public_patch?'wants' then public_patch->>'wants' else wants end,
    is_new=case when public_patch?'is_new' then (public_patch->>'is_new')::boolean else is_new end,
    is_real=case when public_patch?'is_real' then (public_patch->>'is_real')::boolean else is_real end
    where id=target_id returning updated_at into stamp;
  if private_patch<>'{}'::jsonb then detail_revision:=private.write_member_details(target_id,private_patch);
  else select coalesce(revision,0) into detail_revision from private.member_details where member_id=target_id; end if;
  update private.member_interviews set public_patch=apply_member_interview.public_patch,private_patch=apply_member_interview.private_patch,
    status='applied',revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid(),applied_at=clock_timestamp(),analysis_lease=null,analysis_expires_at=null
    where id=target_interview_id returning * into row_value;
  perform private.record_interview(row_value,'applied');
  return jsonb_build_object('interview_id',row_value.id,'revision',row_value.revision,'status',row_value.status,
    'member_id',target_id,'member_updated_at',stamp,'details_revision',coalesce(detail_revision,0));
end $$;

create or replace function private.validate_interview_review_analysis(analysis jsonb,source_ids uuid[])
returns void language plpgsql security invoker set search_path='' as $$
declare suggestion jsonb; source jsonb; source_id uuid; keys text[]:='{}'; key_name text;
begin
  if analysis is null or jsonb_typeof(analysis)<>'object' or pg_column_size(analysis)>1048576
    or jsonb_typeof(analysis->'suggestions') is distinct from 'array' then
    raise exception using errcode='22023',message='통합 분석 결과와 제안 목록을 확인하세요.';
  end if;
  if jsonb_array_length(analysis->'suggestions')>7 then raise exception using errcode='22023',message='분석 제안은 7개 이하로 저장하세요.'; end if;
  for suggestion in select value from jsonb_array_elements(analysis->'suggestions') loop
    key_name:=suggestion->>'key';
    if jsonb_typeof(suggestion)<>'object' or key_name is null or not key_name=any(array['field','customers','synergies','wants','good_referral','triggers','customer_companies'])
      or key_name=any(keys) or jsonb_typeof(suggestion->'value') is distinct from 'array'
      or jsonb_typeof(suggestion->'sources') is distinct from 'array' then
      raise exception using errcode='22023',message='각 제안에는 중복 없는 항목·값·근거 문서가 필요합니다.';
    end if;
    keys:=array_append(keys,key_name);
    if jsonb_array_length(suggestion->'sources')<1 or jsonb_array_length(suggestion->'sources')>20 then
      raise exception using errcode='22023',message='각 제안에 근거 문서를 한 개 이상 지정하세요.';
    end if;
    for source in select value from jsonb_array_elements(suggestion->'sources') loop
      if jsonb_typeof(source)<>'string' or (source#>>'{}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception using errcode='22023',message='근거 문서 식별자를 확인하세요.';
      end if;
      source_id:=(source#>>'{}')::uuid;
      if not source_id=any(source_ids) then raise exception using errcode='22023',message='선택하지 않은 문서는 제안의 근거가 될 수 없습니다.'; end if;
    end loop;
    if exists(select 1 from jsonb_array_elements(suggestion->'value') v where jsonb_typeof(v)<>'string' or char_length(v#>>'{}')>1000)
      or jsonb_array_length(suggestion->'value')>(case when key_name=any(array['field','wants','good_referral']) then 1 else 30 end) then
      raise exception using errcode='22023',message='제안 값의 형식과 길이를 확인하세요.';
    end if;
  end loop;
end $$;

create or replace function private.apply_member_interview_review(target_review_id uuid,expected_revision bigint,expected_member_updated_at timestamptz,
  public_patch jsonb,private_patch jsonb,list_modes jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interview_reviews; target_id uuid; member_row public.members; detail_row private.member_details; stamp timestamptz;
  merged_private jsonb; detail_revision bigint;
begin
  perform private.require_interview_admin();
  perform private.validate_member_patch(public_patch,'public'); perform private.validate_member_patch(private_patch,'private'); perform private.validate_interview_list_modes(list_modes);
  if public_patch='{}'::jsonb and private_patch='{}'::jsonb then raise exception using errcode='22023',message='반영할 항목을 한 개 이상 선택하세요.'; end if;
  select member_id into target_id from private.member_interview_reviews where id=target_review_id;
  if target_id is null then raise exception using errcode='22023',message='통합 검토안을 찾을 수 없습니다.'; end if;
  select * into member_row from public.members where id=target_id for update;
  select * into row_value from private.member_interview_reviews where id=target_review_id for update;
  if expected_revision is null or expected_revision<>row_value.revision or expected_member_updated_at is null or member_row.updated_at is distinct from expected_member_updated_at then
    raise exception using errcode='40001',message='검토안 또는 멤버 정보가 변경되었습니다. 최신 내용과 비교한 후 다시 반영하세요.';
  end if;
  if row_value.status not in ('draft','reviewed') then raise exception using errcode='55000',message='검토할 분석 결과를 확인하세요. 문서는 다시 분석할 수 있습니다.'; end if;
  perform private.assert_interview_review_sources(row_value);
  select * into detail_row from private.member_details where member_id=target_id for update;
  update public.members set
    name=case when public_patch?'name' then btrim(public_patch->>'name') else name end,
    company=case when public_patch?'company' then public_patch->>'company' else company end,
    field=case when public_patch?'field' then public_patch->>'field' else field end,
    customers=case when public_patch?'customers' then private.merge_interview_list(customers,public_patch->'customers',coalesce(list_modes->>'customers','append')) else customers end,
    synergies=case when public_patch?'synergies' then private.merge_interview_list(synergies,public_patch->'synergies',coalesce(list_modes->>'synergies','append')) else synergies end,
    wants=case when public_patch?'wants' then public_patch->>'wants' else wants end,
    is_new=case when public_patch?'is_new' then (public_patch->>'is_new')::boolean else is_new end,
    is_real=case when public_patch?'is_real' then (public_patch->>'is_real')::boolean else is_real end
    where id=target_id returning updated_at into stamp;
  merged_private:=private_patch;
  if private_patch?'triggers' then merged_private:=jsonb_set(merged_private,'{triggers}',to_jsonb(private.merge_interview_list(detail_row.triggers,private_patch->'triggers',coalesce(list_modes->>'triggers','append')))); end if;
  if private_patch?'customer_companies' then merged_private:=jsonb_set(merged_private,'{customer_companies}',to_jsonb(private.merge_interview_list(detail_row.customer_companies,private_patch->'customer_companies',coalesce(list_modes->>'customer_companies','append')))); end if;
  if merged_private<>'{}'::jsonb then detail_revision:=private.write_member_details(target_id,merged_private); else detail_revision:=coalesce(detail_row.revision,0); end if;
  update private.member_interview_reviews set public_patch=apply_member_interview_review.public_patch,private_patch=apply_member_interview_review.private_patch,
    list_modes=apply_member_interview_review.list_modes,status='applied',revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid(),applied_at=clock_timestamp()
    where id=target_review_id returning * into row_value;
  perform private.record_interview_review(row_value,'applied');
  return private.interview_review_snapshot(row_value)||jsonb_build_object('member_updated_at',stamp,'details_revision',detail_revision);
end $$;

revoke all on function private.guard_member_management() from public,anon,authenticated;
drop trigger if exists members_management_guard on public.members;
create trigger members_management_guard before insert or update or delete on public.members for each row execute function private.guard_member_management();
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
create trigger members_legacy_insert_guard before insert on public.members for each row execute function private.reject_legacy_member_team_write();
drop trigger if exists members_legacy_team_guard on public.members;
create trigger members_legacy_team_guard before update of team on public.members for each row execute function private.reject_legacy_member_team_write();
notify pgrst,'reload schema';
commit;
