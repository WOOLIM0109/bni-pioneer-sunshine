-- Rerunnable member-level interview review setup.
-- Run AFTER schema.sql, roles.sql and interviews.sql. No external AI request.
-- Keep private out of Data API exposed schemas; all source/review RPCs are admin-only.
begin;

alter table private.member_interviews add column if not exists stages text[];
alter table private.member_interviews add column if not exists stages_manually_set boolean not null default false;

create or replace function private.infer_interview_stages(file_name text, body text)
returns text[] language sql immutable security invoker set search_path='' as $$
  select array(select stage from (values
    ('profile',1,'신상[[:space:]_-]*명세[[:space:]_-]*표|personal[[:space:]_-]*profile'),
    ('visibility',2,'아는[[:space:]_-]*단계|visibility'),
    ('credibility',3,'신뢰[[:space:]_-]*단계|credibility'),
    ('profitability',4,'수익[[:space:]_-]*단계|profitability')
  ) rules(stage,position,pattern)
  where (coalesce(file_name,'')||E'\n'||coalesce(body,'')) ~* pattern order by position);
$$;
update private.member_interviews set stages=private.infer_interview_stages(original_name,raw_text) where stages is null;
alter table private.member_interviews alter column stages set default '{}', alter column stages set not null;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='private.member_interviews'::regclass and conname='member_interviews_stages_valid') then
    alter table private.member_interviews add constraint member_interviews_stages_valid
      check (stages <@ array['profile','visibility','credibility','profitability']::text[] and array_position(stages,null) is null and cardinality(stages)<=4);
  end if;
end $$;
create or replace function private.assign_interview_stages()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
  if not new.stages_manually_set and (tg_op='INSERT' or new.raw_text is distinct from old.raw_text or new.original_name is distinct from old.original_name) then
    new.stages:=private.infer_interview_stages(new.original_name,new.raw_text);
  end if;
  return new;
end $$;
drop trigger if exists member_interviews_infer_stages on private.member_interviews;
create trigger member_interviews_infer_stages before insert or update on private.member_interviews
  for each row execute function private.assign_interview_stages();

create table if not exists private.member_interview_reviews (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete restrict,
  source_interview_ids uuid[] not null check(cardinality(source_interview_ids) between 1 and 20 and array_position(source_interview_ids,null) is null),
  source_revisions jsonb not null check(jsonb_typeof(source_revisions)='object'),
  source_documents jsonb not null check(jsonb_typeof(source_documents)='array'),
  extracted jsonb not null default '{}' check(jsonb_typeof(extracted)='object'),
  public_patch jsonb not null default '{}' check(jsonb_typeof(public_patch)='object'),
  private_patch jsonb not null default '{}' check(jsonb_typeof(private_patch)='object'),
  list_modes jsonb not null default '{}' check(jsonb_typeof(list_modes)='object'),
  status text not null default 'analyzing' check(status in ('analyzing','draft','reviewed','applied','cancelled')),
  revision bigint not null default 1 check(revision>0),
  analysis_lease uuid,
  analysis_expires_at timestamptz,
  analysis_started_at timestamptz not null default clock_timestamp(),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  applied_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null
);
create index if not exists member_interview_reviews_member_idx on private.member_interview_reviews(member_id,created_at desc);
create index if not exists member_interview_reviews_sources_idx on private.member_interview_reviews using gin(source_interview_ids);
create table if not exists private.member_interview_review_history (
  id bigint generated always as identity primary key,
  review_id uuid not null references private.member_interview_reviews(id) on delete cascade,
  revision bigint not null,
  action text not null check(action in ('created','analyzed','draft_saved','applied','cancelled')),
  snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  unique(review_id,revision)
);
alter table private.member_interview_reviews enable row level security;
alter table private.member_interview_review_history enable row level security;
revoke all on private.member_interview_reviews,private.member_interview_review_history from public,anon,authenticated;
revoke all on sequence private.member_interview_review_history_id_seq from public,anon,authenticated;
drop policy if exists member_interview_reviews_admin on private.member_interview_reviews;
create policy member_interview_reviews_admin on private.member_interview_reviews for all to authenticated
  using ((select private.is_member_admin())) with check ((select private.is_member_admin()));
drop policy if exists member_interview_review_history_admin on private.member_interview_review_history;
create policy member_interview_review_history_admin on private.member_interview_review_history for select to authenticated
  using ((select private.is_member_admin()));

create or replace function private.interview_review_snapshot(row_value private.member_interview_reviews)
returns jsonb language sql stable security invoker set search_path='' as $$
  select (to_jsonb(row_value)-'analysis_lease'-'analysis_expires_at') || jsonb_build_object(
    'sources_stale',exists(select 1 from unnest(row_value.source_interview_ids) s(id)
      left join private.member_interviews d on d.id=s.id where d.id is null or d.member_id<>row_value.member_id
        or row_value.source_revisions->>s.id::text is distinct from d.revision::text),
    'has_new_documents',exists(select 1 from private.member_interviews d where d.member_id=row_value.member_id
      and d.created_at>row_value.created_at and not d.id=any(row_value.source_interview_ids)));
$$;
create or replace function private.record_interview_review(row_value private.member_interview_reviews,event_name text)
returns void language sql security invoker set search_path='' as $$
  insert into private.member_interview_review_history(review_id,revision,action,snapshot,created_by)
  values(row_value.id,row_value.revision,event_name,private.interview_review_snapshot(row_value),auth.uid());
$$;
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
create or replace function private.validate_interview_list_modes(modes jsonb)
returns void language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb;
begin
  if modes is null or jsonb_typeof(modes)<>'object' then raise exception using errcode='22023',message='목록 반영 방식을 확인하세요.'; end if;
  for k,v in select key,value from jsonb_each(modes) loop
    if not k=any(array['customers','synergies','triggers','customer_companies']) or jsonb_typeof(v)<>'string' or v#>>'{}' not in ('append','replace') then
      raise exception using errcode='22023',message='목록 항목은 기존에 추가 또는 전체 교체로 선택하세요.';
    end if;
  end loop;
end $$;
create or replace function private.merge_interview_list(current_values text[],incoming jsonb,mode text default 'append')
returns text[] language sql immutable security invoker set search_path='' as $$
  select coalesce(array_agg(value order by position),'{}'::text[]) from (
    select distinct on (normalized) normalized,value,position from (
      select btrim(regexp_replace(value,'[[:space:]]+',' ','g')) value,
        lower(regexp_replace(value,'[[:space:]]+','','g')) normalized,position
      from unnest((case when mode='replace' then '{}'::text[] else coalesce(current_values,'{}') end)
        || array(select jsonb_array_elements_text(incoming))) with ordinality a(value,position)
    ) normalized where normalized<>'' order by normalized,position
  ) unique_values;
$$;
create or replace function private.assert_interview_review_sources(row_value private.member_interview_reviews)
returns void language plpgsql security invoker set search_path='' as $$
begin
  perform 1 from private.member_interviews where id=any(row_value.source_interview_ids) order by id for update;
  if exists(select 1 from unnest(row_value.source_interview_ids) s(id) left join private.member_interviews d on d.id=s.id
    where d.id is null or d.member_id<>row_value.member_id or row_value.source_revisions->>s.id::text is distinct from d.revision::text) then
    raise exception using errcode='40001',message='분석에 사용한 문서가 변경되었습니다. 최신 원문으로 다시 분석하세요.';
  end if;
end $$;

create or replace function private.begin_member_interview_review_analysis(target_interview_ids uuid[])
returns jsonb language plpgsql security definer set search_path='' as $$
declare target_id uuid; documents jsonb; revisions jsonb; row_value private.member_interview_reviews;
  token uuid:=gen_random_uuid(); deadline timestamptz:=clock_timestamp()+interval '3 minutes';
begin
  perform private.require_interview_admin();
  if target_interview_ids is null or cardinality(target_interview_ids) not between 1 and 20 or array_position(target_interview_ids,null) is not null
    or cardinality(target_interview_ids)<>(select count(distinct id) from unnest(target_interview_ids) ids(id)) then
    raise exception using errcode='22023',message='같은 멤버의 문서를 1~20개 선택하세요.';
  end if;
  select member_id into target_id from private.member_interviews where id=target_interview_ids[1];
  if target_id is null then raise exception using errcode='22023',message='선택한 문서를 찾을 수 없습니다.'; end if;
  -- The member lock serializes starts/applies; source locks use deterministic order.
  perform 1 from public.members where id=target_id for update;
  perform 1 from private.member_interviews where id=any(target_interview_ids) order by id for update;
  if (select count(*) from private.member_interviews where id=any(target_interview_ids) and member_id=target_id)<>cardinality(target_interview_ids) then
    raise exception using errcode='22023',message='다른 멤버의 문서를 함께 분석할 수 없습니다.';
  end if;
  if (select coalesce(sum(char_length(raw_text)),0) from private.member_interviews where id=any(target_interview_ids))>240000 then
    raise exception using errcode='22023',message='선택 문서 원문은 합계 240,000자 이하로 분석하세요.';
  end if;
  if exists(select 1 from private.member_interview_reviews where member_id=target_id and
    ((analysis_lease is not null and analysis_expires_at>clock_timestamp()) or analysis_started_at>clock_timestamp()-interval '30 seconds'))
    or exists(select 1 from private.member_interviews where member_id=target_id and
      ((analysis_lease is not null and analysis_expires_at>clock_timestamp()) or analysis_started_at>clock_timestamp()-interval '30 seconds')) then
    raise exception using errcode='55000',message='이 멤버를 이미 분석 중이거나 방금 요청했습니다. 잠시 후 확인하세요.';
  end if;
  -- Exclude legacy extraction/approval payloads: only the source itself is AI
  -- input. This also keeps a maximum-size batch below the Edge RPC response cap.
  select jsonb_agg((private.interview_snapshot(d)-'extracted'-'public_patch'-'private_patch') order by d.created_at,d.id),jsonb_object_agg(d.id::text,d.revision)
    into documents,revisions from private.member_interviews d where d.id=any(target_interview_ids);
  insert into private.member_interview_reviews(member_id,source_interview_ids,source_revisions,source_documents,analysis_lease,analysis_expires_at,created_by,updated_by)
    values(target_id,target_interview_ids,revisions,documents,token,deadline,auth.uid(),auth.uid()) returning * into row_value;
  perform private.record_interview_review(row_value,'created');
  return jsonb_build_object('review',private.interview_review_snapshot(row_value)-'source_documents','documents',documents,'lease_id',token,'expires_at',deadline);
end $$;
create or replace function private.finish_member_interview_review_analysis(target_review_id uuid,expected_revision bigint,lease_id uuid,analysis jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interview_reviews; target_id uuid; result jsonb;
begin
  perform private.require_interview_admin();
  select member_id into target_id from private.member_interview_reviews where id=target_review_id;
  if target_id is null then raise exception using errcode='22023',message='통합 분석을 찾을 수 없습니다.'; end if;
  perform 1 from public.members where id=target_id for update;
  select * into row_value from private.member_interview_reviews where id=target_review_id for update;
  if expected_revision is null or row_value.revision<>expected_revision or lease_id is null or row_value.analysis_lease is distinct from lease_id
    or row_value.analysis_expires_at is null or row_value.analysis_expires_at<=clock_timestamp() or row_value.status<>'analyzing' then
    raise exception using errcode='40001',message='분석 작업이 만료되었거나 변경되었습니다. 최신 상태를 확인하세요.';
  end if;
  perform private.assert_interview_review_sources(row_value);
  result:=case when analysis?'extracted' then analysis->'extracted' else analysis end;
  perform private.validate_interview_review_analysis(result,row_value.source_interview_ids);
  update private.member_interview_reviews set extracted=result,public_patch='{}',private_patch='{}',list_modes='{}',status='draft',
    revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid(),analysis_lease=null,analysis_expires_at=null
    where id=target_review_id returning * into row_value;
  perform private.record_interview_review(row_value,'analyzed');
  return private.interview_review_snapshot(row_value);
end $$;
create or replace function private.cancel_member_interview_review_analysis(target_review_id uuid,lease_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interview_reviews;
begin
  perform private.require_interview_admin();
  update private.member_interview_reviews set analysis_lease=null,analysis_expires_at=null,status='cancelled',revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid()
    where id=target_review_id and analysis_lease=lease_id and status='analyzing' returning * into row_value;
  if not found then return jsonb_build_object('released',false); end if;
  perform private.record_interview_review(row_value,'cancelled');
  return jsonb_build_object('released',true);
end $$;
create or replace function private.list_member_interview_reviews(target_member_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_interview_admin();
  select coalesce(jsonb_agg(private.interview_review_snapshot(r)-'source_documents' order by created_at desc,id),'[]') into result
    from private.member_interview_reviews r where member_id=target_member_id;
  return result;
end $$;
create or replace function private.get_member_interview_review(target_review_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interview_reviews; history_value jsonb;
begin
  perform private.require_interview_admin();
  select * into row_value from private.member_interview_reviews where id=target_review_id;
  if not found then raise exception using errcode='22023',message='통합 검토안을 찾을 수 없습니다.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('revision',revision,'action',action,'snapshot',snapshot,'created_at',created_at,'created_by',created_by) order by revision),'[]')
    into history_value from private.member_interview_review_history where review_id=target_review_id;
  return private.interview_review_snapshot(row_value)||jsonb_build_object('history',history_value);
end $$;
create or replace function private.save_member_interview_review(target_review_id uuid,expected_revision bigint,draft_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interview_reviews; target_id uuid; k text; v jsonb;
begin
  perform private.require_interview_admin();
  if draft_patch is null or jsonb_typeof(draft_patch)<>'object' or pg_column_size(draft_patch)>2097152 then raise exception using errcode='22023',message='검토 초안 형식을 확인하세요.'; end if;
  select member_id into target_id from private.member_interview_reviews where id=target_review_id;
  if target_id is null then raise exception using errcode='22023',message='통합 검토안을 찾을 수 없습니다.'; end if;
  perform 1 from public.members where id=target_id for update;
  select * into row_value from private.member_interview_reviews where id=target_review_id for update;
  if expected_revision is null or expected_revision<>row_value.revision then raise exception using errcode='40001',message='검토안이 변경되었습니다. 최신 내용을 다시 확인하세요.'; end if;
  if row_value.status not in ('draft','reviewed') then raise exception using errcode='55000',message='완료된 분석의 검토 초안만 저장할 수 있습니다.'; end if;
  perform private.assert_interview_review_sources(row_value);
  for k,v in select key,value from jsonb_each(draft_patch) loop
    if k='extracted' then perform private.validate_interview_review_analysis(v,row_value.source_interview_ids);
    elsif k='public_patch' then perform private.validate_member_patch(v,'public');
    elsif k='private_patch' then perform private.validate_member_patch(v,'private');
    elsif k='list_modes' then perform private.validate_interview_list_modes(v);
    else raise exception using errcode='22023',message='허용되지 않은 검토 항목입니다: '||k; end if;
  end loop;
  update private.member_interview_reviews set extracted=coalesce(draft_patch->'extracted',extracted),public_patch=coalesce(draft_patch->'public_patch',public_patch),
    private_patch=coalesce(draft_patch->'private_patch',private_patch),list_modes=coalesce(draft_patch->'list_modes',list_modes),
    status='reviewed',revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid() where id=target_review_id returning * into row_value;
  perform private.record_interview_review(row_value,'draft_saved');
  return private.interview_review_snapshot(row_value);
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

-- Documents remain reusable after any number of applied reviews. Editing source
-- text/tags preserves historical approvals and invalidates reviews via revision.
create or replace function private.save_member_interview_draft(target_interview_id uuid,expected_revision bigint,draft_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interviews; target_id uuid; k text; v jsonb; next_stages text[]; next_raw text;
begin
  perform private.require_interview_admin();
  if draft_patch is null or jsonb_typeof(draft_patch)<>'object' then raise exception using errcode='22023',message='문서 초안 형식을 확인하세요.'; end if;
  -- Preserve the legacy review save contract for existing un-applied documents.
  if exists(select 1 from jsonb_object_keys(draft_patch) keys(k) where keys.k not in ('raw_text','stages')) then
    if draft_patch?'stages' then raise exception using errcode='22023',message='단계와 원문을 저장한 후 검토 항목을 저장하세요.'; end if;
    return private.save_interview_patch(target_interview_id,expected_revision,draft_patch,'draft_saved');
  end if;
  select member_id into target_id from private.member_interviews where id=target_interview_id;
  if target_id is null then raise exception using errcode='22023',message='문서를 찾을 수 없습니다.'; end if;
  perform 1 from public.members where id=target_id for update;
  select * into row_value from private.member_interviews where id=target_interview_id for update;
  if expected_revision is null or row_value.revision<>expected_revision then raise exception using errcode='40001',message='문서가 변경되었습니다. 최신 내용을 확인하세요.'; end if;
  if row_value.analysis_lease is not null and row_value.analysis_expires_at>clock_timestamp() then raise exception using errcode='55000',message='이전 문서 분석이 완료된 후 수정하세요.'; end if;
  next_raw:=row_value.raw_text; next_stages:=row_value.stages;
  if draft_patch?'raw_text' then
    if jsonb_typeof(draft_patch->'raw_text')<>'string' or char_length(draft_patch->>'raw_text')>120000 then raise exception using errcode='22023',message='원문은 120,000자 이하 문자열이어야 합니다.'; end if;
    next_raw:=draft_patch->>'raw_text';
  end if;
  if draft_patch?'stages' then
    if jsonb_typeof(draft_patch->'stages')<>'array' or jsonb_array_length(draft_patch->'stages')>4 or exists(
      select 1 from jsonb_array_elements(draft_patch->'stages') s where jsonb_typeof(s)<>'string' or not s#>>'{}'=any(array['profile','visibility','credibility','profitability'])) then
      raise exception using errcode='22023',message='문서 단계를 확인하세요.';
    end if;
    select coalesce(array_agg(stage order by position),'{}'::text[]) into next_stages from
      unnest(array['profile','visibility','credibility','profitability']) with ordinality stages(stage,position) where draft_patch->'stages' ? stage;
  elsif not row_value.stages_manually_set then next_stages:=private.infer_interview_stages(row_value.original_name,next_raw); end if;
  if row(row_value.raw_text,row_value.stages,row_value.stages_manually_set) is not distinct from row(next_raw,next_stages,row_value.stages_manually_set or draft_patch?'stages') then return private.interview_snapshot(row_value); end if;
  update private.member_interviews set raw_text=next_raw,stages=next_stages,stages_manually_set=stages_manually_set or draft_patch?'stages',
    revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid() where id=target_interview_id returning * into row_value;
  perform private.record_interview(row_value,'draft_saved');
  return private.interview_snapshot(row_value);
end $$;
create or replace function private.list_member_interviews(target_member_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_interview_admin();
  select coalesce(jsonb_agg(jsonb_build_object('id',d.id,'member_id',d.member_id,'original_name',d.original_name,'mime_type',d.mime_type,'file_size',d.file_size,
    'status',d.status,'stages',d.stages,'revision',d.revision,'created_at',d.created_at,'updated_at',d.updated_at,'applied_at',d.applied_at,
    'usage_status',case when d.status='applied' or exists(select 1 from private.member_interview_reviews r where d.id=any(r.source_interview_ids) and r.status='applied') then 'applied'
      when d.extracted<>'{}'::jsonb or exists(select 1 from private.member_interview_reviews r where d.id=any(r.source_interview_ids) and r.status in ('draft','reviewed','applied')) then 'analyzed'
      else 'unanalyzed' end) order by d.created_at desc,d.id),'[]') into result
    from private.member_interviews d where target_member_id is null or d.member_id=target_member_id;
  return result;
end $$;

-- Older open clients cannot start a separate paid analysis while a member-level
-- analysis is running. Both start paths serialize on the same member row.
create or replace function private.begin_member_interview_analysis(target_interview_id uuid,expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interviews; target_id uuid; token uuid:=gen_random_uuid(); deadline timestamptz:=clock_timestamp()+interval '3 minutes';
begin
  perform private.require_interview_admin();
  select member_id into target_id from private.member_interviews where id=target_interview_id;
  if target_id is null then raise exception using errcode='22023',message='질문지를 찾을 수 없습니다.'; end if;
  perform 1 from public.members where id=target_id for update;
  select * into row_value from private.member_interviews where id=target_interview_id for update;
  if expected_revision is null or row_value.revision<>expected_revision then raise exception using errcode='40001',message='질문지가 변경되었습니다. 새로고침 후 분석하세요.'; end if;
  if row_value.status='applied' then raise exception using errcode='22023',message='반영에 사용한 문서는 멤버 통합 분석에서 다시 선택하세요.'; end if;
  if exists(select 1 from private.member_interview_reviews where member_id=target_id and
      ((analysis_lease is not null and analysis_expires_at>clock_timestamp()) or analysis_started_at>clock_timestamp()-interval '30 seconds'))
    or exists(select 1 from private.member_interviews where member_id=target_id and
      ((analysis_lease is not null and analysis_expires_at>clock_timestamp()) or analysis_started_at>clock_timestamp()-interval '30 seconds')) then
    raise exception using errcode='55000',message='이 멤버를 이미 분석 중이거나 방금 요청했습니다. 잠시 후 확인하세요.';
  end if;
  update private.member_interviews set analysis_lease=token,analysis_expires_at=deadline,analysis_started_at=clock_timestamp() where id=target_interview_id;
  return jsonb_build_object('lease_id',token,'expires_at',deadline,'interview',private.interview_snapshot(row_value));
end $$;

create or replace function public.begin_member_interview_review_analysis(target_interview_ids uuid[])
returns jsonb language sql security invoker set search_path='' as $$ select private.begin_member_interview_review_analysis(target_interview_ids); $$;
create or replace function public.finish_member_interview_review_analysis(target_review_id uuid,expected_revision bigint,lease_id uuid,analysis jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.finish_member_interview_review_analysis(target_review_id,expected_revision,lease_id,analysis); $$;
create or replace function public.cancel_member_interview_review_analysis(target_review_id uuid,lease_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.cancel_member_interview_review_analysis(target_review_id,lease_id); $$;
create or replace function public.list_member_interview_reviews(target_member_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.list_member_interview_reviews(target_member_id); $$;
create or replace function public.get_member_interview_review(target_review_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.get_member_interview_review(target_review_id); $$;
create or replace function public.save_member_interview_review(target_review_id uuid,expected_revision bigint,draft_patch jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.save_member_interview_review(target_review_id,expected_revision,draft_patch); $$;
create or replace function public.apply_member_interview_review(target_review_id uuid,expected_revision bigint,expected_member_updated_at timestamptz,public_patch jsonb,private_patch jsonb,list_modes jsonb default '{}')
returns jsonb language sql security invoker set search_path='' as $$ select private.apply_member_interview_review(target_review_id,expected_revision,expected_member_updated_at,public_patch,private_patch,list_modes); $$;

do $$ declare f regprocedure; s text; n text; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname='private'
    and p.proname=any(array['infer_interview_stages','assign_interview_stages','interview_review_snapshot','record_interview_review','validate_interview_review_analysis','validate_interview_list_modes','merge_interview_list','assert_interview_review_sources']) loop
    execute format('revoke all on function %s from public,anon,authenticated',f);
  end loop;
  foreach s in array array['private','public'] loop
    foreach n in array array['begin_member_interview_review_analysis','finish_member_interview_review_analysis','cancel_member_interview_review_analysis','list_member_interview_reviews','get_member_interview_review','save_member_interview_review','apply_member_interview_review','save_member_interview_draft','list_member_interviews'] loop
      for f in select p.oid::regprocedure from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname=s and p.proname=n loop
        execute format('revoke all on function %s from public,anon,authenticated',f);
        execute format('grant execute on function %s to authenticated',f);
      end loop;
    end loop;
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
