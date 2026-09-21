-- Supabase SQL Editor에서 실행합니다. 같은 스크립트를 다시 실행할 수 있습니다.
-- 기존 members 테이블이 있다면 열 구조가 아래 정의와 같은지 먼저 확인하세요.
begin;

create table if not exists public.members (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  company       text not null default '',
  field         text not null default '',
  team          text not null default '미정',
  customers     text[] not null default '{}',
  synergies     text[] not null default '{}',
  wants         text not null default '',
  good_referral text not null default '',
  triggers      text[] not null default '{}',
  is_new        boolean not null default false,
  is_real       boolean not null default false,
  sort_order    int not null default 0,
  updated_at    timestamptz not null default now(),
  updated_by    text not null default ''
);

-- 성함에는 UNIQUE를 걸지 않습니다. 동명이인은 별도 UUID로 관리합니다.
create index if not exists members_sort_idx on public.members (sort_order, name);
alter table public.members enable row level security;

drop policy if exists members_read_all on public.members;
create policy members_read_all
  on public.members for select
  using (true);

drop policy if exists members_write_authed on public.members;
create policy members_write_authed
  on public.members for all
  to authenticated
  using (true) with check (true);

-- 기본 권한 설정과 관계없이 공개 읽기 / 로그인 후 쓰기를 명시합니다.
grant usage on schema public to anon, authenticated, service_role;
revoke all privileges on table public.members from anon, authenticated;
grant select on table public.members to anon;
grant select, insert, update, delete on table public.members to authenticated;
grant select, insert, update, delete on table public.members to service_role;

create or replace function public.touch_members()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce(auth.jwt() ->> 'email', '');
  return new;
end;
$$;

drop trigger if exists members_touch on public.members;
create trigger members_touch
  before insert or update on public.members
  for each row execute function public.touch_members();

-- Supabase Realtime이 INSERT / UPDATE / DELETE를 공개 읽기 화면에도 전달합니다.
do $$
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'members'
  ) then
    alter publication supabase_realtime add table public.members;
  end if;
end;
$$;

commit;
