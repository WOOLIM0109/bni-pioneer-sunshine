-- Reviewable, rerunnable setup; run AFTER schema.sql / roles.sql.
-- Deploy the matching public-only frontend/seed before accepting questionnaires.
-- No AI requests are made by this SQL. All document/proposal access is admin-only.
begin;

create table if not exists private.member_details (
  member_id uuid primary key references public.members(id) on delete cascade,
  customer_companies text[] not null default '{}',
  good_referral text not null default '',
  triggers text[] not null default '{}',
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default clock_timestamp(),
  updated_by uuid references auth.users(id) on delete set null
);
create table if not exists private.member_interviews (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.members(id) on delete restrict,
  storage_path text not null unique,
  original_name text not null,
  mime_type text not null,
  file_size bigint not null check (file_size > 0 and file_size <= 20971520),
  raw_text text not null default '' check (char_length(raw_text) <= 120000),
  extracted jsonb not null default '{}' check (jsonb_typeof(extracted) = 'object'),
  public_patch jsonb not null default '{}' check (jsonb_typeof(public_patch) = 'object'),
  private_patch jsonb not null default '{}' check (jsonb_typeof(private_patch) = 'object'),
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'applied')),
  revision bigint not null default 1 check (revision > 0),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  applied_at timestamptz,
  analysis_lease uuid,
  analysis_expires_at timestamptz,
  analysis_started_at timestamptz
);
create index if not exists member_interviews_member_idx on private.member_interviews(member_id, created_at desc);
create table if not exists private.member_interview_history (
  id bigint generated always as identity primary key,
  interview_id uuid not null references private.member_interviews(id) on delete cascade,
  revision bigint not null,
  action text not null check (action in ('created', 'draft_saved', 'analyzed', 'applied')),
  snapshot jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  created_by uuid references auth.users(id) on delete set null,
  unique(interview_id, revision)
);
alter table private.member_details enable row level security;
alter table private.member_interviews enable row level security;
alter table private.member_interview_history enable row level security;
revoke all on private.member_details, private.member_interviews, private.member_interview_history from public, anon, authenticated;
revoke all on sequence private.member_interview_history_id_seq from public, anon, authenticated;
drop policy if exists member_details_scoped_read on private.member_details;
create policy member_details_scoped_read on private.member_details for select to authenticated
  using (private.can_edit_member(member_id));
drop policy if exists member_interviews_admin on private.member_interviews;
create policy member_interviews_admin on private.member_interviews for all to authenticated
  using ((select private.is_member_admin())) with check ((select private.is_member_admin()));
drop policy if exists member_interview_history_admin on private.member_interview_history;
create policy member_interview_history_admin on private.member_interview_history for select to authenticated
  using ((select private.is_member_admin()));

-- Move existing sensitive values and clear their public copies in one transaction.
-- Existing public customers are CATEGORY labels; never infer company names here.
do $$ begin
  if exists (select 1 from public.members m join private.member_details d on d.member_id=m.id
    where (m.good_referral<>'' and d.good_referral<>'' and m.good_referral<>d.good_referral)
       or (cardinality(m.triggers)>0 and cardinality(d.triggers)>0 and m.triggers<>d.triggers)) then
    raise exception '공개·비공개 리퍼럴 값이 서로 다릅니다. 관리자가 확인한 후 다시 실행하세요.';
  end if;
end $$;
insert into private.member_details(member_id, good_referral, triggers)
select id, good_referral, triggers from public.members where good_referral<>'' or cardinality(triggers)>0
on conflict(member_id) do update set
  good_referral=case when member_details.good_referral='' then excluded.good_referral else member_details.good_referral end,
  triggers=case when cardinality(member_details.triggers)=0 then excluded.triggers else member_details.triggers end,
  revision=member_details.revision+1, updated_at=clock_timestamp()
where (member_details.good_referral='' and excluded.good_referral<>'')
   or (cardinality(member_details.triggers)=0 and cardinality(excluded.triggers)>0);
update public.members set good_referral='', triggers='{}' where good_referral<>'' or cardinality(triggers)>0;
create or replace function private.reject_public_member_secrets()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if coalesce(new.good_referral,'')<>'' or coalesce(cardinality(new.triggers),0)>0 then
    raise exception using errcode='42501', message='좋은 리퍼럴과 트리거는 비공개 정보입니다. 비공개 정보 칸에서 저장하세요.';
  end if;
  return new;
end $$;
revoke all on function private.reject_public_member_secrets() from public, anon, authenticated;
drop trigger if exists members_private_fields_guard on public.members;
create trigger members_private_fields_guard before insert or update on public.members
  for each row execute function private.reject_public_member_secrets();
create or replace function private.guard_member_interviews_delete()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(select 1 from private.member_interviews where member_id=old.id) then
    raise exception using errcode='P0001',message='질문지 원문이 연결된 멤버입니다. 원문 보관을 정리한 뒤 삭제하세요.';
  end if;
  return old;
end $$;
revoke all on function private.guard_member_interviews_delete() from public,anon,authenticated;
drop trigger if exists members_interviews_delete_guard on public.members;
create trigger members_interviews_delete_guard before delete on public.members
  for each row execute function private.guard_member_interviews_delete();

-- Storage metadata comes from Storage, not the create RPC's client parameters.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('member-interviews','member-interviews',false,20971520,
  array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
drop policy if exists sunshine_interview_storage_read on storage.objects;
drop policy if exists sunshine_interview_storage_insert on storage.objects;
drop policy if exists sunshine_interview_storage_update on storage.objects;
drop policy if exists sunshine_interview_storage_delete on storage.objects;
create policy sunshine_interview_storage_read on storage.objects for select to authenticated
  using (bucket_id='member-interviews' and (select private.is_member_admin()));
create policy sunshine_interview_storage_insert on storage.objects for insert to authenticated
  with check (bucket_id='member-interviews' and (select private.is_member_admin()));
create policy sunshine_interview_storage_update on storage.objects for update to authenticated
  using (bucket_id='member-interviews' and (select private.is_member_admin()))
  with check (bucket_id='member-interviews' and (select private.is_member_admin()));
create policy sunshine_interview_storage_delete on storage.objects for delete to authenticated
  using (bucket_id='member-interviews' and (select private.is_member_admin()));

-- Existing policies can OR with these permissive policies; add a restrictive
-- boundary so a broad policy for another upload feature cannot expose this bucket.
drop policy if exists sunshine_interview_storage_boundary on storage.objects;
drop policy if exists sunshine_interview_storage_anon_boundary on storage.objects;
create policy sunshine_interview_storage_anon_boundary on storage.objects as restrictive for all to anon
  using (bucket_id<>'member-interviews') with check (bucket_id<>'member-interviews');
create policy sunshine_interview_storage_boundary on storage.objects as restrictive for all to authenticated
  using (bucket_id<>'member-interviews' or (select private.is_member_admin()))
  with check (bucket_id<>'member-interviews' or (select private.is_member_admin()));

create or replace function private.require_interview_admin()
returns void language plpgsql security definer set search_path='' as $$
begin
  -- Lock order: role lock, public member row, interview row, details row.
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if not private.is_member_admin() then
    raise exception using errcode='42501', message='질문지 원문과 분석 결과는 관리자만 열람·저장할 수 있습니다.';
  end if;
end $$;
create or replace function private.validate_member_patch(patch jsonb, patch_kind text)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare k text; v jsonb; item jsonb; allowed text[];
begin
  if patch is null or jsonb_typeof(patch)<>'object' or pg_column_size(patch)>1048576 then
    raise exception using errcode='22023', message='저장할 항목은 1MB 이하의 JSON 객체여야 합니다.';
  end if;
  if patch_kind='public' then allowed:=array['name','company','field','team','customers','synergies','wants','is_new','is_real'];
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
create or replace function private.interview_snapshot(row_value private.member_interviews)
returns jsonb language sql immutable security invoker set search_path='' as $$
  select to_jsonb(row_value)-'analysis_lease'-'analysis_expires_at'-'analysis_started_at';
$$;
create or replace function private.record_interview(row_value private.member_interviews, event_name text)
returns void language sql security invoker set search_path='' as $$
  insert into private.member_interview_history(interview_id,revision,action,snapshot,created_by)
  values (row_value.id,row_value.revision,event_name,private.interview_snapshot(row_value),auth.uid());
$$;
create or replace function private.get_member_details(target_member_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; linked uuid;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if not private.is_member_admin() then
    select a.member_id into linked from public.member_accounts a where a.user_id=auth.uid() and a.role='member';
    if linked is null or not private.can_edit_member(linked) or (target_member_id is not null and target_member_id<>linked) then
      raise exception using errcode='42501',message='승인된 본인의 비공개 정보만 볼 수 있습니다.';
    end if;
    target_member_id:=linked;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('member_id',m.id,'good_referral',coalesce(d.good_referral,''),
    'triggers',coalesce(d.triggers,'{}'::text[]),'customer_companies',coalesce(d.customer_companies,'{}'::text[]),
    'revision',coalesce(d.revision,0)) order by m.sort_order,m.name),'[]') into result
  from public.members m left join private.member_details d on d.member_id=m.id
  where target_member_id is null or m.id=target_member_id;
  return result;
end $$;
create or replace function private.write_member_details(target_member_id uuid, details_patch jsonb)
returns bigint language plpgsql security invoker set search_path='' as $$
declare rev bigint;
begin
  insert into private.member_details(member_id,good_referral,triggers,customer_companies,updated_by)
  values (target_member_id,coalesce(details_patch->>'good_referral',''),
    case when details_patch?'triggers' then array(select jsonb_array_elements_text(details_patch->'triggers')) else '{}' end,
    case when details_patch?'customer_companies' then array(select jsonb_array_elements_text(details_patch->'customer_companies')) else '{}' end,auth.uid())
  on conflict(member_id) do update set
    good_referral=case when details_patch?'good_referral' then excluded.good_referral else member_details.good_referral end,
    triggers=case when details_patch?'triggers' then excluded.triggers else member_details.triggers end,
    customer_companies=case when details_patch?'customer_companies' then excluded.customer_companies else member_details.customer_companies end,
    revision=member_details.revision+1,updated_at=clock_timestamp(),updated_by=auth.uid()
  returning revision into rev;
  return rev;
end $$;
create or replace function private.update_member_details(target_member_id uuid, expected_revision bigint, details_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare rev bigint; stamp timestamptz; result jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682,1);
  if not private.can_edit_member(target_member_id) then raise exception using errcode='42501',message='승인된 본인의 비공개 정보만 수정할 수 있습니다.'; end if;
  perform private.validate_member_patch(details_patch,'private');
  perform 1 from public.members where id=target_member_id for update;
  if not found then raise exception using errcode='22023',message='멤버를 찾을 수 없습니다. 새로고침하세요.'; end if;
  select revision into rev from private.member_details where member_id=target_member_id for update;
  if expected_revision is null or expected_revision<>coalesce(rev,0) then
    raise exception using errcode='40001',message='비공개 정보가 변경되었습니다. 최신 내용을 확인한 후 다시 저장하세요.';
  end if;
  if details_patch<>'{}'::jsonb then
    rev:=private.write_member_details(target_member_id,details_patch);
    -- Fires the existing canonical audit trigger, and invalidates stale review CAS.
    update public.members set name=name where id=target_member_id returning updated_at into stamp;
  else select updated_at into stamp from public.members where id=target_member_id; end if;
  result:=(private.get_member_details(target_member_id)->0)||jsonb_build_object('member_updated_at',stamp);
  return result;
end $$;

create or replace function private.create_member_interview(target_member_id uuid, storage_path text, original_name text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare meta jsonb; size_value bigint; mime text; row_value private.member_interviews;
begin
  perform private.require_interview_admin();
  perform 1 from public.members where id=target_member_id for update;
  if not found then raise exception using errcode='22023',message='원문을 연결할 멤버를 찾을 수 없습니다.'; end if;
  if storage_path is null or char_length(storage_path)>1024 or storage_path not like target_member_id::text||'/%'
    or storage_path ~ '(^|/)\.\.(/|$)' or original_name is null or btrim(original_name)='' or char_length(original_name)>255 then
    raise exception using errcode='22023',message='파일명과 멤버별 업로드 경로를 확인하세요.';
  end if;
  select metadata into meta from storage.objects where bucket_id='member-interviews' and name=storage_path;
  if not found then raise exception using errcode='22023',message='업로드한 원문 파일을 찾지 못했습니다. 파일 업로드를 완료한 후 다시 시도하세요.'; end if;
  if coalesce(meta->>'size','') !~ '^[0-9]{1,10}$' then raise exception using errcode='22023',message='업로드 파일 크기를 확인할 수 없습니다. 다시 업로드하세요.'; end if;
  size_value:=(meta->>'size')::bigint; mime:=lower(coalesce(meta->>'mimetype',''));
  if size_value<1 or size_value>20971520 or not mime=any(array['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain']) then
    raise exception using errcode='22023',message='20MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.';
  end if;
  insert into private.member_interviews(member_id,storage_path,original_name,mime_type,file_size,created_by,updated_by)
    values(target_member_id,storage_path,btrim(original_name),mime,size_value,auth.uid(),auth.uid()) returning * into row_value;
  perform private.record_interview(row_value,'created');
  return private.interview_snapshot(row_value);
exception when unique_violation then raise exception using errcode='23505',message='이미 등록한 원문 파일입니다. 질문지 목록에서 확인하세요.';
end $$;
create or replace function private.list_member_interviews(target_member_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;
begin
  perform private.require_interview_admin();
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'member_id',member_id,'original_name',original_name,
    'mime_type',mime_type,'file_size',file_size,'status',status,'revision',revision,'created_at',created_at,
    'updated_at',updated_at,'applied_at',applied_at) order by created_at desc,id),'[]') into result
  from private.member_interviews where target_member_id is null or member_id=target_member_id;
  return result;
end $$;
create or replace function private.get_member_interview(target_interview_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interviews; history_value jsonb;
begin
  perform private.require_interview_admin();
  select * into row_value from private.member_interviews where id=target_interview_id;
  if not found then raise exception using errcode='22023',message='질문지를 찾을 수 없습니다. 목록을 새로고침하세요.'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('revision',revision,'action',action,'snapshot',snapshot,
    'created_at',created_at,'created_by',created_by) order by revision),'[]') into history_value
    from private.member_interview_history where interview_id=target_interview_id;
  return private.interview_snapshot(row_value)||jsonb_build_object('history',history_value);
end $$;
create or replace function private.save_interview_patch(target_interview_id uuid, expected_revision bigint, draft_patch jsonb, event_name text, lease_id uuid default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare row_value private.member_interviews; k text; v jsonb; next_raw text; next_extracted jsonb; next_public jsonb; next_private jsonb; next_status text;
begin
  if draft_patch is null or jsonb_typeof(draft_patch)<>'object' or pg_column_size(draft_patch)>2097152 then
    raise exception using errcode='22023',message='질문지 초안은 2MB 이하 JSON 객체여야 합니다.';
  end if;
  select * into row_value from private.member_interviews where id=target_interview_id for update;
  if not found then raise exception using errcode='22023',message='질문지를 찾을 수 없습니다.'; end if;
  if expected_revision is null or expected_revision<>row_value.revision then raise exception using errcode='40001',message='다른 작업에서 질문지를 수정했습니다. 최신 초안을 다시 확인하세요.'; end if;
  if row_value.status='applied' then raise exception using errcode='22023',message='이미 반영된 질문지입니다. 새로운 문서로 등록하세요.'; end if;
  if lease_id is not null then
    if row_value.analysis_lease is distinct from lease_id or row_value.analysis_expires_at is null or row_value.analysis_expires_at<=clock_timestamp() then
      raise exception using errcode='40001',message='분석 작업이 만료되었습니다. 결과를 확인한 후 다시 요청하세요.';
    end if;
  elsif row_value.analysis_lease is not null and row_value.analysis_expires_at>clock_timestamp() then
    raise exception using errcode='55000',message='질문지를 분석하고 있습니다. 분석 완료 후 초안을 수정하세요.';
  end if;
  for k,v in select key,value from jsonb_each(draft_patch) loop
    if not k=any(array['raw_text','extracted','public_patch','private_patch','status']) then raise exception using errcode='22023',message='허용되지 않은 초안 항목입니다: '||k; end if;
    if k='raw_text' and (jsonb_typeof(v)<>'string' or char_length(v#>>'{}')>120000) then raise exception using errcode='22023',message='원문 텍스트는 120,000자 이하로 입력하세요.'; end if;
    if k='extracted' and (jsonb_typeof(v)<>'object' or pg_column_size(v)>1048576) then raise exception using errcode='22023',message='추출 결과는 1MB 이하 JSON 객체여야 합니다.'; end if;
    if k='status' and (jsonb_typeof(v)<>'string' or v#>>'{}' not in ('draft','reviewed')) then raise exception using errcode='22023',message='초안 또는 검토 상태만 저장할 수 있습니다.'; end if;
    if k='public_patch' then perform private.validate_member_patch(v,'public'); end if;
    if k='private_patch' then perform private.validate_member_patch(v,'private'); end if;
  end loop;
  next_raw:=case when draft_patch?'raw_text' then draft_patch->>'raw_text' else row_value.raw_text end;
  next_extracted:=case when draft_patch?'extracted' then draft_patch->'extracted' else row_value.extracted end;
  -- A completed analysis starts a new review. Never carry old selections forward
  -- or treat incoming analysis patch values as the administrator's approval.
  if lease_id is not null and event_name='analyzed' then
    next_public:='{}'; next_private:='{}';
  else
    -- Ordinary partial review saves retain all absent draft fields.
    next_public:=row_value.public_patch||coalesce(draft_patch->'public_patch','{}');
    next_private:=row_value.private_patch||coalesce(draft_patch->'private_patch','{}');
  end if;
  next_status:=coalesce(draft_patch->>'status','draft');
  if row(row_value.raw_text,row_value.extracted,row_value.public_patch,row_value.private_patch,row_value.status)
     is not distinct from row(next_raw,next_extracted,next_public,next_private,next_status) then
    if lease_id is not null then update private.member_interviews set analysis_lease=null,analysis_expires_at=null where id=target_interview_id; end if;
    return private.interview_snapshot(row_value);
  end if;
  update private.member_interviews set raw_text=next_raw,extracted=next_extracted,public_patch=next_public,
    private_patch=next_private,status=next_status,revision=revision+1,updated_at=clock_timestamp(),updated_by=auth.uid(),analysis_lease=null,analysis_expires_at=null
    where id=target_interview_id returning * into row_value;
  perform private.record_interview(row_value,event_name);
  return private.interview_snapshot(row_value);
end $$;
create or replace function private.save_member_interview_draft(target_interview_id uuid, expected_revision bigint, draft_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.require_interview_admin();
  return private.save_interview_patch(target_interview_id,expected_revision,draft_patch,'draft_saved');
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
    team=case when public_patch?'team' then coalesce(nullif(btrim(public_patch->>'team'),''),'미정') else team end,
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

create or replace function private.begin_member_interview_analysis(target_interview_id uuid, expected_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare row_value private.member_interviews; token uuid:=gen_random_uuid(); deadline timestamptz:=clock_timestamp()+interval '3 minutes';
begin
  perform private.require_interview_admin();
  select * into row_value from private.member_interviews where id=target_interview_id for update;
  if not found then raise exception using errcode='22023',message='질문지를 찾을 수 없습니다.'; end if;
  if expected_revision is null or row_value.revision<>expected_revision then raise exception using errcode='40001',message='질문지가 변경되었습니다. 새로고침 후 분석하세요.'; end if;
  if row_value.status='applied' then raise exception using errcode='22023',message='이미 반영한 질문지입니다.'; end if;
  if (row_value.analysis_lease is not null and row_value.analysis_expires_at>clock_timestamp())
    or row_value.analysis_started_at>clock_timestamp()-interval '30 seconds' then
    raise exception using errcode='55000',message='이미 분석 중이거나 방금 요청했습니다. 잠시 후 다시 확인하세요.';
  end if;
  update private.member_interviews set analysis_lease=token,analysis_expires_at=deadline,analysis_started_at=clock_timestamp()
    where id=target_interview_id;
  return jsonb_build_object('lease_id',token,'expires_at',deadline,'interview',private.interview_snapshot(row_value));
end $$;
create or replace function private.finish_member_interview_analysis(target_interview_id uuid, lease_id uuid, expected_revision bigint, analysis_patch jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  perform private.require_interview_admin();
  if lease_id is null or analysis_patch is null or analysis_patch?'status' then raise exception using errcode='22023',message='분석 작업 식별자와 결과를 확인하세요.'; end if;
  return private.save_interview_patch(target_interview_id,expected_revision,analysis_patch,'analyzed',lease_id);
end $$;
create or replace function private.cancel_member_interview_analysis(target_interview_id uuid, lease_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare released boolean;
begin
  perform private.require_interview_admin();
  update private.member_interviews set analysis_lease=null,analysis_expires_at=null
    where id=target_interview_id and analysis_lease=lease_id;
  released:=found; return jsonb_build_object('released',released);
end $$;

-- RPC wrappers intentionally contain no privilege-bearing implementation.
create or replace function public.get_member_details(target_member_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$ select private.get_member_details(target_member_id); $$;
create or replace function public.update_member_details(target_member_id uuid, expected_revision bigint, details_patch jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.update_member_details(target_member_id,expected_revision,details_patch); $$;
create or replace function public.create_member_interview(target_member_id uuid, storage_path text, original_name text)
returns jsonb language sql security invoker set search_path='' as $$ select private.create_member_interview(target_member_id,storage_path,original_name); $$;
create or replace function public.list_member_interviews(target_member_id uuid default null)
returns jsonb language sql security invoker set search_path='' as $$ select private.list_member_interviews(target_member_id); $$;
create or replace function public.get_member_interview(target_interview_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.get_member_interview(target_interview_id); $$;
create or replace function public.save_member_interview_draft(target_interview_id uuid, expected_revision bigint, draft_patch jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.save_member_interview_draft(target_interview_id,expected_revision,draft_patch); $$;
create or replace function public.apply_member_interview(target_interview_id uuid, expected_revision bigint, expected_member_updated_at timestamptz, public_patch jsonb, private_patch jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.apply_member_interview(target_interview_id,expected_revision,expected_member_updated_at,public_patch,private_patch); $$;
create or replace function public.begin_member_interview_analysis(target_interview_id uuid, expected_revision bigint)
returns jsonb language sql security invoker set search_path='' as $$ select private.begin_member_interview_analysis(target_interview_id,expected_revision); $$;
create or replace function public.finish_member_interview_analysis(target_interview_id uuid, lease_id uuid, expected_revision bigint, analysis_patch jsonb)
returns jsonb language sql security invoker set search_path='' as $$ select private.finish_member_interview_analysis(target_interview_id,lease_id,expected_revision,analysis_patch); $$;
create or replace function public.cancel_member_interview_analysis(target_interview_id uuid, lease_id uuid)
returns jsonb language sql security invoker set search_path='' as $$ select private.cancel_member_interview_analysis(target_interview_id,lease_id); $$;

-- Internal helpers are never directly callable. Only explicitly listed RPCs are.
do $$ declare f regprocedure; s text; n text; begin
  for f in select p.oid::regprocedure from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace
    where ns.nspname='private' and p.proname=any(array['require_interview_admin','validate_member_patch','interview_snapshot','record_interview','write_member_details','save_interview_patch']) loop
    execute format('revoke all on function %s from public, anon, authenticated',f);
  end loop;
  foreach s in array array['private','public'] loop
    foreach n in array array['get_member_details','update_member_details','create_member_interview','list_member_interviews','get_member_interview','save_member_interview_draft','apply_member_interview','begin_member_interview_analysis','finish_member_interview_analysis','cancel_member_interview_analysis'] loop
      for f in select p.oid::regprocedure from pg_proc p join pg_namespace ns on ns.oid=p.pronamespace where ns.nspname=s and p.proname=n loop
        execute format('revoke all on function %s from public, anon, authenticated',f);
        execute format('grant execute on function %s to authenticated',f);
      end loop;
    end loop;
  end loop;
end $$;
-- No private table is added to supabase_realtime. Keep the private schema out of
-- the Data API's exposed schemas. Existing public columns remain empty for old clients.
notify pgrst, 'reload schema';
commit;
