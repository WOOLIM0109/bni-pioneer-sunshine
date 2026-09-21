-- Run after schema.sql/roles.sql. Safe to rerun; existing links are retained.
-- A link overrides only the target UUID. The original synergy text stays intact.
begin;

create table if not exists public.member_synergy_links (
  source_member_id uuid not null references public.members(id) on delete cascade,
  synergy text not null check (char_length(synergy) between 1 and 1000),
  target_member_id uuid not null references public.members(id) on delete cascade,
  updated_at timestamptz not null default clock_timestamp(),
  primary key (source_member_id, synergy),
  constraint member_synergy_links_no_self check (source_member_id <> target_member_id)
);
create index if not exists member_synergy_links_target_idx
  on public.member_synergy_links(target_member_id);

alter table public.member_synergy_links enable row level security;
revoke all on public.member_synergy_links from public, anon, authenticated;
grant select on public.member_synergy_links to anon, authenticated;
grant select, insert, update, delete on public.member_synergy_links to service_role;
drop policy if exists sunshine_member_synergy_links_read on public.member_synergy_links;
create policy sunshine_member_synergy_links_read on public.member_synergy_links
  for select to anon, authenticated using (true);

create or replace function private.sunshine_set_member_synergy_link(
  p_source_member_id uuid,
  p_synergy text,
  p_target_member_id uuid,
  p_expected_member_updated_at timestamptz,
  p_expected_link_updated_at timestamptz
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  source_row public.members%rowtype;
  link_row public.member_synergy_links%rowtype;
  link_exists boolean;
begin
  -- Role assignments take the exclusive version of this lock. Read the current
  -- database role after locking, never a client-editable or stale JWT role.
  perform pg_catalog.pg_advisory_xact_lock_shared(1835363682, 1);
  if not private.is_member_admin() then
    raise exception using errcode = '42501',
      message = '관리자만 상생직군 연결을 지정하거나 해제할 수 있습니다. 관리자에게 요청하세요.';
  end if;
  if p_source_member_id is null or p_synergy is null
     or char_length(p_synergy) not between 1 and 1000
     or p_expected_member_updated_at is null then
    raise exception using errcode = '22023',
      message = '멤버와 상생직군 원문, 확인한 수정 시각이 필요합니다. 새로고침한 뒤 다시 선택하세요.';
  end if;
  if p_target_member_id = p_source_member_id then
    raise exception using errcode = '22023',
      message = '본인에게 연결할 수 없습니다. 다른 멤버를 선택하세요.';
  end if;

  -- Lock both member rows in UUID order so cross-links cannot deadlock each
  -- other. The source lock also serializes inserts when no mapping exists yet.
  perform m.id from public.members m
    where m.id = p_source_member_id or m.id = p_target_member_id
    order by m.id for update;
  select m.* into source_row from public.members m where m.id = p_source_member_id;
  if not found then
    raise exception using errcode = '22023',
      message = '연결을 지정할 멤버를 찾지 못했습니다. 최신 명단을 다시 불러오세요.';
  end if;
  if source_row.updated_at is distinct from p_expected_member_updated_at then
    raise exception using errcode = '40001',
      message = '멤버 정보가 다른 곳에서 변경되었습니다. 최신 정보를 확인한 뒤 연결을 다시 지정하세요.';
  end if;
  if not coalesce(p_synergy = any(source_row.synergies), false) then
    raise exception using errcode = '22023',
      message = '현재 멤버 정보에 없는 상생직군입니다. 원문을 확인하고 최신 목록에서 다시 선택하세요.';
  end if;

  select l.* into link_row from public.member_synergy_links l
    where l.source_member_id = p_source_member_id and l.synergy = p_synergy
    for update;
  link_exists := found;
  if (link_exists and link_row.updated_at is distinct from p_expected_link_updated_at)
     or (not link_exists and p_expected_link_updated_at is not null) then
    raise exception using errcode = '40001',
      message = '상생직군 연결이 다른 곳에서 변경되었습니다. 최신 연결을 확인한 뒤 다시 지정하세요.';
  end if;

  if p_target_member_id is null then
    if link_exists then
      delete from public.member_synergy_links l
        where l.source_member_id = p_source_member_id and l.synergy = p_synergy;
    end if;
    return null;
  end if;
  if not exists (select 1 from public.members m where m.id = p_target_member_id) then
    raise exception using errcode = '22023',
      message = '연결할 상대 멤버를 찾지 못했습니다. 최신 명단에서 다시 선택하세요.';
  end if;

  -- Explicit branches preserve the expected-absent vs expected-existing check.
  -- clock_timestamp (not transaction-wide now) gives successive confirmations
  -- distinct versions, including multiple calls in a single transaction.
  if link_exists then
    update public.member_synergy_links l
      set target_member_id = p_target_member_id,
          updated_at = greatest(clock_timestamp(), link_row.updated_at + interval '1 microsecond')
      where l.source_member_id = p_source_member_id and l.synergy = p_synergy
      returning l.* into link_row;
  else
    insert into public.member_synergy_links(source_member_id, synergy, target_member_id, updated_at)
      values (p_source_member_id, p_synergy, p_target_member_id, clock_timestamp())
      returning * into link_row;
  end if;
  return to_jsonb(link_row);
exception when program_limit_exceeded then
  -- PostgreSQL B-tree entries also have a byte limit. Some incompressible
  -- multi-byte strings can exceed it while still fitting the character limit.
  -- Keep the original intact and return an actionable validation error.
  raise exception using errcode = '22023',
    message = '상생직군 문구가 너무 깁니다. 멤버 정보에서 업종명만 짧게 정리한 뒤 다시 연결하세요.';
end;
$$;

-- The public RPC is an invoker wrapper. The private implementation performs its
-- own authorization before using owner privileges and an empty search_path.
create or replace function public.set_member_synergy_link(
  source_member_id uuid,
  synergy text,
  target_member_id uuid,
  expected_member_updated_at timestamptz,
  expected_link_updated_at timestamptz
)
returns jsonb language sql security invoker set search_path = ''
as $$
  select private.sunshine_set_member_synergy_link(
    source_member_id, synergy, target_member_id,
    expected_member_updated_at, expected_link_updated_at
  );
$$;
revoke all on function private.sunshine_set_member_synergy_link(uuid, text, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.set_member_synergy_link(uuid, text, uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function private.sunshine_set_member_synergy_link(uuid, text, uuid, timestamptz, timestamptz)
  to authenticated;
grant execute on function public.set_member_synergy_link(uuid, text, uuid, timestamptz, timestamptz)
  to authenticated;

do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public'
        and tablename = 'member_synergy_links'
  ) then
    alter publication supabase_realtime add table public.member_synergy_links;
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;
