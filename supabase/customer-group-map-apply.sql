-- Run manually in the SQL Editor. Application builds never execute this file.
-- Adds only customer classification objects; does not update members or interviews.
begin;
create schema if not exists private;

create or replace function public.customer_label_key(label text)
returns text language sql immutable parallel safe set search_path = '' as $$
  select lower(regexp_replace(normalize(translate(coalesce(label,''),'·ㆍ・‧∙⋅·',''),NFKC),U&'[[:space:]\FEFF]+','','g'));
$$;
revoke all on function public.customer_label_key(text) from public;
grant execute on function public.customer_label_key(text) to anon, authenticated, service_role;

create table if not exists public.customer_groups (
  name text primary key check (char_length(name) between 1 and 80 and name <> '기타'),
  sort_order integer not null unique,
  is_seed boolean not null default false,
  created_at timestamptz not null default now()
);
create table if not exists public.customer_group_map (
  label text not null check (char_length(label) between 1 and 1000),
  label_key text generated always as (public.customer_label_key(label)) stored primary key check (label_key <> ''),
  group_name text not null references public.customer_groups(name),
  source text not null check (source in ('seed','ai','manual')),
  reason text not null default '' check (char_length(reason) <= 500),
  member_count integer not null default 0 check (member_count >= 0),
  updated_at timestamptz not null default now()
);
create index if not exists customer_group_map_group_idx on public.customer_group_map(group_name);
alter table public.customer_groups enable row level security;
alter table public.customer_group_map enable row level security;
revoke all on public.customer_groups, public.customer_group_map from public, anon, authenticated, service_role;
grant select on public.customer_groups, public.customer_group_map to anon, authenticated, service_role;
drop policy if exists customer_groups_read on public.customer_groups;
create policy customer_groups_read on public.customer_groups for select to anon, authenticated using (true);
drop policy if exists customer_group_map_read on public.customer_group_map;
create policy customer_group_map_read on public.customer_group_map for select to anon, authenticated using (true);

create or replace function private.guard_customer_group_limit()
returns trigger language plpgsql set search_path = '' as $$
begin
  perform pg_catalog.pg_advisory_xact_lock(1129534541,1);
  if not exists(select 1 from public.customer_groups where name=new.name)
     and (select count(*) from public.customer_groups)>=20 then
    raise exception using errcode='22023', message='고객 묶음은 최대 20개입니다.';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_customer_group_limit() from public, anon, authenticated;
drop trigger if exists customer_group_limit on public.customer_groups;
create trigger customer_group_limit before insert on public.customer_groups for each row execute function private.guard_customer_group_limit();

create temporary table customer_group_seed(groups jsonb) on commit drop;
insert into customer_group_seed values ($customer_groups$
[
  {
    "name": "소상공인·소기업 대표",
    "labels": [
      "소기업 대표",
      "개인·소상공인",
      "1인 창업자",
      "팀 단위 사업자",
      "법인 사업자",
      "법률자문이 필요한 기업·소상공인"
    ],
    "sort_order": 0
  },
  {
    "name": "숙박·병원·상가 사업주",
    "labels": [
      "숙박·병원·상가 사업주",
      "병·의원 원장",
      "병·의원 운영·행정 책임자",
      "개원 준비 의료인",
      "요양병원",
      "동물병원",
      "펫 관련샵 업주"
    ],
    "sort_order": 1
  },
  {
    "name": "기업 총무·인사·행사 담당",
    "labels": [
      "기업 인사·총무",
      "행사 주최자",
      "명절 선물 구매 기업",
      "회식 기업",
      "직원 복지에 관심 있는 사업주",
      "협회·단체 운영자",
      "팀·기업"
    ],
    "sort_order": 2
  },
  {
    "name": "중견기업 대표·임원",
    "labels": [
      "중기업 대표",
      "대표·임원",
      "하이엔드 전문직"
    ],
    "sort_order": 3
  },
  {
    "name": "건축주·건설사",
    "labels": [
      "신축·리모델링 건축주",
      "건설사",
      "건설 현장소장",
      "건물 관리 담당자",
      "상가 임대인",
      "부동산 임대사업자"
    ],
    "sort_order": 4
  },
  {
    "name": "이사·입주 가구",
    "labels": [
      "이사·입주 가구",
      "아파트 공동구매 담당자"
    ],
    "sort_order": 5
  },
  {
    "name": "부모·가족",
    "labels": [
      "부모·가족",
      "중장년 가장",
      "라이프케어 관심 가정",
      "고령 부모 부양 50대",
      "반려동물 가정",
      "유아·초등 학부모",
      "가족 외식 손님"
    ],
    "sort_order": 6
  },
  {
    "name": "창업 준비자",
    "labels": [
      "창업 준비자",
      "스타트업·창업 준비자",
      "3년 내 (예비)창업자",
      "정책자금·정부지원사업 희망 사업자",
      "기업인증 필요 사업자",
      "소개자료·브랜딩 필요 기업"
    ],
    "sort_order": 7
  },
  {
    "name": "제조·무역 대표",
    "labels": [
      "제조·공장 대표",
      "무역·제조업 대표"
    ],
    "sort_order": 8
  },
  {
    "name": "예비부부·웨딩",
    "labels": [
      "예비신랑",
      "예비신랑·신부",
      "신혼·웨딩"
    ],
    "sort_order": 9
  },
  {
    "name": "요식업 점주",
    "labels": [
      "요식업 점주"
    ],
    "sort_order": 10
  },
  {
    "name": "전문직",
    "labels": [
      "정장 입는 전문직"
    ],
    "sort_order": 11
  },
  {
    "name": "미용 소비자",
    "labels": [
      "미용 소비자"
    ],
    "sort_order": 12
  },
  {
    "name": "분쟁·법률 당사자",
    "labels": [
      "상속·분쟁 당사자",
      "계약·거래 분쟁 당사자",
      "소송 대응이 필요한 개인·사업자"
    ],
    "sort_order": 13
  },
  {
    "name": "개인 부업·소득",
    "labels": [
      "고소득 부업 원하는 분"
    ],
    "sort_order": 14
  },
  {
    "name": "해외 거주·주재원",
    "labels": [
      "해외 거주·주재원"
    ],
    "sort_order": 15
  },
  {
    "name": "BNI 챕터 운영진",
    "labels": [
      "BNI 챕터 운영자",
      "BNI 챕터 의장단·디렉터"
    ],
    "sort_order": 16
  }
]
$customer_groups$::jsonb);
insert into public.customer_groups(name,sort_order,is_seed)
select item->>'name',(item->>'sort_order')::integer,true from customer_group_seed,jsonb_array_elements(groups) item
on conflict(name) do nothing;
insert into public.customer_group_map(label,group_name,source)
select distinct on (public.customer_label_key(label)) label,item->>'name','seed'
from customer_group_seed,jsonb_array_elements(groups) item,
  lateral jsonb_array_elements_text((item->'labels')||jsonb_build_array(item->>'name')) label
on conflict(label_key) do nothing; -- Reapplying never overwrites AI/manual decisions.

create table if not exists private.customer_classification_state (
  singleton boolean primary key default true check(singleton),
  lease_id uuid,
  expires_at timestamptz,
  snapshot jsonb not null default '[]',
  last_fingerprint text
);
revoke all on private.customer_classification_state from public, anon, authenticated, service_role;
alter table private.customer_classification_state enable row level security;
insert into private.customer_classification_state(singleton) values(true) on conflict do nothing;

create or replace function private.customer_label_snapshot()
returns jsonb language sql stable security definer set search_path = '' as $$
  with labels as (
    select public.customer_label_key(input.label) as label_key,min(input.label) as label,
      jsonb_agg(distinct m.id order by m.id) as member_ids,
      bool_or(mapping.label_key is null) as unmapped
    from public.members m cross join lateral unnest(m.customers) as input(label)
    left join public.customer_group_map mapping on mapping.label_key=public.customer_label_key(input.label)
    where char_length(input.label) between 1 and 1000 and public.customer_label_key(input.label)<>''
      and (mapping.source is null or mapping.source='ai')
    group by public.customer_label_key(input.label)
    order by unmapped desc,label_key limit 200
  ) select coalesce(jsonb_agg(jsonb_build_object('label_key',label_key,'label',label,'member_ids',member_ids) order by label_key),'[]') from labels;
$$;
revoke all on function private.customer_label_snapshot() from public, anon, authenticated;

-- Service-only capabilities: the Edge handler first verifies the real user and
-- their current approved account. Browser roles cannot call these functions.
create or replace function public.begin_customer_label_classification()
returns jsonb language plpgsql security definer set search_path = '' as $$
declare state private.customer_classification_state; current_snapshot jsonb; lease uuid; groups jsonb;
begin
  perform pg_catalog.pg_advisory_xact_lock(1129534541,1);
  select * into state from private.customer_classification_state where singleton for update;
  if state.lease_id is not null and state.expires_at>clock_timestamp() then return jsonb_build_object('busy',true); end if;
  current_snapshot:=private.customer_label_snapshot();
  if current_snapshot='[]' or md5(current_snapshot::text)=state.last_fingerprint then return jsonb_build_object('unchanged',true); end if;
  lease:=gen_random_uuid();
  update private.customer_classification_state set lease_id=lease,expires_at=clock_timestamp()+interval '110 seconds',snapshot=current_snapshot where singleton;
  select jsonb_agg(jsonb_build_object('name',g.name,'examples',
    (select coalesce(jsonb_agg(e.label),'[]') from (select label from public.customer_group_map where group_name=g.name order by label_key limit 8)e)) order by g.sort_order)
    into groups from public.customer_groups g;
  return jsonb_build_object('lease_id',lease,'labels',current_snapshot,'groups',groups);
end;
$$;

create or replace function public.finish_customer_label_classification(target_lease_id uuid,assignments jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare state private.customer_classification_state; item jsonb; entry jsonb; proposed text; fallback text; chosen text; cohort integer; saved integer:=0;
begin
  perform pg_catalog.pg_advisory_xact_lock(1129534541,1);
  select * into state from private.customer_classification_state where singleton for update;
  if state.lease_id is null or state.lease_id is distinct from target_lease_id or state.expires_at<=clock_timestamp() then
    raise exception using errcode='40001',message='분류 작업이 만료되었습니다.';
  end if;
  if state.snapshot is distinct from private.customer_label_snapshot() then
    raise exception using errcode='40001',message='고객 표현이 변경되었습니다. 다음 로드에서 다시 분류합니다.';
  end if;
  if assignments is null or jsonb_typeof(assignments)<>'array' or jsonb_array_length(assignments)<>jsonb_array_length(state.snapshot)
    or (select count(distinct a->>'label_key') from jsonb_array_elements(assignments)a)<>jsonb_array_length(assignments) then
    raise exception using errcode='22023',message='분류 결과의 표현 목록이 일치하지 않습니다.';
  end if;
  for item in select value from jsonb_array_elements(assignments) loop
    if jsonb_typeof(item)<>'object' or not (item ?& array['label_key','group_name','fallback_group','reason']) or not exists(select 1 from jsonb_array_elements(state.snapshot)s where s->>'label_key'=item->>'label_key')
      or jsonb_typeof(item->'group_name')<>'string' or char_length(item->>'group_name') not between 1 and 80 or item->>'group_name'='기타'
      or jsonb_typeof(item->'reason')<>'string' or char_length(item->>'reason')>500
      or not exists(select 1 from public.customer_groups where name=item->>'fallback_group') then
      raise exception using errcode='22023',message='허용되지 않은 고객 분류 결과입니다.';
    end if;
  end loop;
  -- Count actual distinct member UUIDs, not expression count or model claims.
  for proposed in select distinct a->>'group_name' from jsonb_array_elements(assignments)a order by 1 loop
    if exists(select 1 from public.customer_groups where name=proposed) then continue; end if;
    select count(distinct member_id) into cohort
    from jsonb_array_elements(assignments)a join jsonb_array_elements(state.snapshot)s on s->>'label_key'=a->>'label_key'
      cross join lateral jsonb_array_elements_text(s->'member_ids') member_id where a->>'group_name'=proposed;
    if cohort>=2 and (select count(*) from public.customer_groups)<20 then
      insert into public.customer_groups(name,sort_order) select proposed,coalesce(max(sort_order),-1)+1 from public.customer_groups;
    end if;
  end loop;
  for item in select value from jsonb_array_elements(assignments) loop
    select value into entry from jsonb_array_elements(state.snapshot) where value->>'label_key'=item->>'label_key';
    chosen:=case when exists(select 1 from public.customer_groups where name=item->>'group_name') then item->>'group_name' else item->>'fallback_group' end;
    insert into public.customer_group_map(label,group_name,source,reason,member_count)
      values(entry->>'label',chosen,'ai',item->>'reason',jsonb_array_length(entry->'member_ids'))
    on conflict(label_key) do update set group_name=excluded.group_name,reason=excluded.reason,member_count=excluded.member_count,updated_at=clock_timestamp()
      where customer_group_map.source='ai';
    saved:=saved+1;
  end loop;
  update private.customer_classification_state set last_fingerprint=md5(state.snapshot::text),lease_id=null,expires_at=null,snapshot='[]' where singleton;
  return jsonb_build_object('classified',saved,'groups',(select count(*) from public.customer_groups));
end;
$$;
create or replace function public.cancel_customer_label_classification(target_lease_id uuid)
returns void language sql security definer set search_path = '' as $$
  update private.customer_classification_state set lease_id=null,expires_at=null,snapshot='[]' where singleton and lease_id=target_lease_id;
$$;
revoke all on function public.begin_customer_label_classification(),public.finish_customer_label_classification(uuid,jsonb),public.cancel_customer_label_classification(uuid) from public,anon,authenticated;
grant execute on function public.begin_customer_label_classification(),public.finish_customer_label_classification(uuid,jsonb),public.cancel_customer_label_classification(uuid) to service_role;
notify pgrst,'reload schema';
commit;
