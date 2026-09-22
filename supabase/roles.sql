-- Existing installations: run this complete file in the Supabase SQL Editor.
-- New installations: schema.sql includes the same permission setup.
-- No first administrator is chosen automatically. Bootstrap a confirmed account
-- separately, after the owner identifies its email address.
begin;

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists public.member_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null default '',
  role text not null default 'viewer' check (role in ('viewer', 'member', 'admin')),
  member_id uuid unique references public.members(id) on delete restrict,
  requested_member_id uuid references public.members(id) on delete set null,
  request_status text not null default 'none'
    check (request_status in ('none', 'pending', 'approved', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint member_accounts_role_member_check check (
    (role = 'member' and member_id is not null)
    or (role in ('viewer', 'admin') and member_id is null)
  )
);
create index if not exists member_accounts_requested_member_idx
  on public.member_accounts(requested_member_id) where requested_member_id is not null;
alter table public.member_accounts enable row level security;
revoke all on public.member_accounts from public, anon, authenticated;
grant select on public.member_accounts to authenticated;
grant select, insert, update, delete on public.member_accounts to service_role;

-- Read current database roles, never user-editable metadata or stale JWT roles.
create or replace function private.is_member_admin()
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.member_accounts a
    join auth.users u on u.id = a.user_id
    where a.user_id = (select auth.uid()) and a.role = 'admin'
      and u.email_confirmed_at is not null and coalesce(u.email, '') <> ''
      and not coalesce(u.is_anonymous, false)
  );
$$;
create or replace function private.can_edit_member(target_member_id uuid)
returns boolean language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.member_accounts a
    join auth.users u on u.id = a.user_id
    where a.user_id = (select auth.uid())
      and (a.role = 'admin' or (a.role = 'member' and a.member_id = target_member_id))
      and u.email_confirmed_at is not null and coalesce(u.email, '') <> ''
      and not coalesce(u.is_anonymous, false)
  );
$$;
revoke all on function private.is_member_admin() from public, anon, authenticated;
revoke all on function private.can_edit_member(uuid) from public, anon, authenticated;
grant execute on function private.is_member_admin() to authenticated;
grant execute on function private.can_edit_member(uuid) to authenticated;

drop policy if exists member_accounts_read_self_or_admin on public.member_accounts;
create policy member_accounts_read_self_or_admin on public.member_accounts
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.is_member_admin()));

create or replace function private.sync_member_account()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.member_accounts(user_id, email)
  values (new.id, coalesce(new.email, ''))
  on conflict (user_id) do update
    set email = excluded.email, updated_at = now();
  return new;
end;
$$;
revoke all on function private.sync_member_account() from public, anon, authenticated;
drop trigger if exists sunshine_sync_member_account on auth.users;
create trigger sunshine_sync_member_account
  after insert or update of email on auth.users
  for each row execute function private.sync_member_account();
insert into public.member_accounts(user_id, email)
select id, coalesce(email, '') from auth.users
on conflict (user_id) do update set email = excluded.email;

-- Serialize role changes so two concurrent demotions cannot remove every admin.
create or replace function private.guard_member_account()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if old.role = 'admin' and (tg_op = 'DELETE' or new.role <> 'admin') then
    perform pg_catalog.pg_advisory_xact_lock(1835363682, 1);
    if not exists (
      select 1 from public.member_accounts a
      join auth.users u on u.id = a.user_id
      where a.role = 'admin' and a.user_id <> old.user_id
        and u.email_confirmed_at is not null and coalesce(u.email, '') <> ''
        and not coalesce(u.is_anonymous, false)
    ) then
      raise exception using errcode = 'P0001',
        message = '마지막 관리자는 해제하거나 삭제할 수 없습니다. 다른 관리자를 먼저 지정하세요.';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function private.guard_member_account() from public, anon, authenticated;
drop trigger if exists member_accounts_guard on public.member_accounts;
create trigger member_accounts_guard before update or delete on public.member_accounts
  for each row execute function private.guard_member_account();

create or replace function private.request_member_access(target_member_id uuid)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  account public.member_accounts%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from auth.users u where u.id = auth.uid()
      and u.email_confirmed_at is not null and coalesce(u.email, '') <> ''
      and not coalesce(u.is_anonymous, false)
  ) then
    raise exception using errcode = '42501', message = '이메일 인증 후 다시 로그인하여 신청하세요.';
  end if;
  select * into account from public.member_accounts where user_id = auth.uid() for update;
  if not found then
    raise exception using errcode = 'P0001', message = '가입 정보를 찾을 수 없습니다. 관리자에게 문의하세요.';
  end if;
  if account.role <> 'viewer' then
    raise exception using errcode = '42501', message = '이미 수정 권한이 있습니다. 멤버 연결 변경은 관리자에게 요청하세요.';
  end if;
  if target_member_id is null or not exists (select 1 from public.members where id = target_member_id) then
    raise exception using errcode = 'P0001', message = '연결할 멤버를 찾을 수 없습니다. 새로고침한 뒤 본인을 선택하세요.';
  end if;
  if exists (select 1 from public.member_accounts where member_id = target_member_id) then
    raise exception using errcode = 'P0001', message = '이미 다른 계정과 연결된 멤버입니다. 관리자에게 문의하세요.';
  end if;
  update public.member_accounts set requested_member_id = target_member_id, request_status = 'pending'
    where user_id = auth.uid() returning * into account;
  return to_jsonb(account);
end;
$$;

create or replace function private.admin_set_member_access(
  target_user_id uuid, access_role text, target_member_id uuid default null
)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  account public.member_accounts%rowtype;
begin
  -- All assignment RPCs take this lock BEFORE checking the actor or locking rows.
  perform pg_catalog.pg_advisory_xact_lock(1835363682, 1);
  if not private.is_member_admin() then
    raise exception using errcode = '42501', message = '관리자만 권한을 변경할 수 있습니다. 관리자에게 문의하세요.';
  end if;
  if access_role is null or access_role not in ('viewer', 'member', 'admin') then
    raise exception using errcode = '22023', message = '읽기·본인 수정·관리자 중 하나를 선택하세요.';
  end if;
  select * into account from public.member_accounts where user_id = target_user_id for update;
  if not found then
    raise exception using errcode = 'P0001', message = '가입한 계정을 찾을 수 없습니다. 회원가입 후 다시 확인하세요.';
  end if;
  if access_role <> 'viewer' and not exists (
    select 1 from auth.users u where u.id = target_user_id
      and u.email_confirmed_at is not null and coalesce(u.email, '') <> ''
      and not coalesce(u.is_anonymous, false)
  ) then
    raise exception using errcode = 'P0001', message = '이메일 인증이 끝나지 않은 계정입니다. 먼저 메일에서 인증해 주세요.';
  end if;
  if access_role = 'member' then
    if target_member_id is null or not exists (select 1 from public.members where id = target_member_id) then
      raise exception using errcode = '22023', message = '본인 수정 권한에는 연결할 멤버를 선택해야 합니다.';
    end if;
    if exists (select 1 from public.member_accounts where member_id = target_member_id and user_id <> target_user_id) then
      raise exception using errcode = 'P0001', message = '이 멤버는 다른 계정에 연결되어 있습니다. 기존 연결을 해제한 뒤 다시 지정하세요.';
    end if;
  elsif target_member_id is not null then
    raise exception using errcode = '22023', message = '읽기 또는 관리자 권한은 멤버 연결을 비워 주세요.';
  end if;
  update public.member_accounts
    set role = access_role, member_id = target_member_id,
        requested_member_id = case when access_role = 'member' then target_member_id else null end,
        request_status = case when access_role in ('member', 'admin') then 'approved'
                              when account.request_status = 'none' then 'none' else 'rejected' end
    where user_id = target_user_id returning * into account;
  return to_jsonb(account);
exception when unique_violation then
  raise exception using errcode = 'P0001', message = '이 멤버는 다른 계정에 연결되어 있습니다. 새로고침 후 연결을 확인하세요.';
end;
$$;

-- Only admins can inspect confirmation status; auth.users remains private.
create or replace function private.list_member_accounts()
returns table (
  user_id uuid, email text, role text, member_id uuid, requested_member_id uuid,
  request_status text, created_at timestamptz, updated_at timestamptz,
  email_confirmed boolean
)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if not private.is_member_admin() then
    raise exception using errcode = '42501', message = '관리자만 계정과 인증 상태를 확인할 수 있습니다.';
  end if;
  return query
    select a.user_id, a.email, a.role, a.member_id, a.requested_member_id,
      a.request_status, a.created_at, a.updated_at,
      (u.email_confirmed_at is not null and coalesce(u.email, '') <> ''
       and not coalesce(u.is_anonymous, false)) as email_confirmed
    from public.member_accounts a
    join auth.users u on u.id = a.user_id
    order by a.email, a.user_id;
end;
$$;

-- Public endpoints are invoker wrappers; privilege-bearing implementations stay
-- outside the exposed schema. All implementations perform their own auth checks.
create or replace function public.list_member_accounts()
returns table (
  user_id uuid, email text, role text, member_id uuid, requested_member_id uuid,
  request_status text, created_at timestamptz, updated_at timestamptz,
  email_confirmed boolean
)
language sql stable security invoker set search_path = ''
as $$ select * from private.list_member_accounts(); $$;
create or replace function public.request_member_access(target_member_id uuid)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.request_member_access(target_member_id); $$;
create or replace function public.admin_set_member_access(
  target_user_id uuid, access_role text, target_member_id uuid default null
)
returns jsonb language sql security invoker set search_path = ''
as $$ select private.admin_set_member_access(target_user_id, access_role, target_member_id); $$;
revoke all on function private.list_member_accounts() from public, anon, authenticated;
revoke all on function public.list_member_accounts() from public, anon, authenticated;
revoke all on function private.request_member_access(uuid) from public, anon, authenticated;
revoke all on function private.admin_set_member_access(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.request_member_access(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_member_access(uuid, text, uuid) from public, anon, authenticated;
grant execute on function private.list_member_accounts() to authenticated;
grant execute on function public.list_member_accounts() to authenticated;
grant execute on function private.request_member_access(uuid) to authenticated;
grant execute on function private.admin_set_member_access(uuid, text, uuid) to authenticated;
grant execute on function public.request_member_access(uuid) to authenticated;
grant execute on function public.admin_set_member_access(uuid, text, uuid) to authenticated;

-- Remove the previous any-signed-in-user write policy before adding scoped ones.
alter table public.members enable row level security;
drop policy if exists members_write_authed on public.members;
drop policy if exists members_read_all on public.members;
drop policy if exists members_insert_admin on public.members;
drop policy if exists members_update_own_or_admin on public.members;
drop policy if exists members_delete_admin on public.members;
create policy members_read_all on public.members for select to anon, authenticated using (true);
create policy members_insert_admin on public.members for insert to authenticated
  with check ((select private.is_member_admin()));
create policy members_update_own_or_admin on public.members for update to authenticated
  using (private.can_edit_member(id)) with check (private.can_edit_member(id));
create policy members_delete_admin on public.members for delete to authenticated
  using ((select private.is_member_admin()));

grant usage on schema public to anon, authenticated, service_role;
revoke all on public.members from public, anon, authenticated;
-- Explicit columns keep the editor's audit email out of the public API/realtime.
grant select (id, name, company, field, team, customers, synergies, wants,
  good_referral, triggers, is_new, is_real, sort_order, updated_at)
  on public.members to anon, authenticated;
grant insert, update, delete on public.members to authenticated;
grant select, insert, update, delete on public.members to service_role;

create or replace function private.guard_member_management()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    if exists (select 1 from public.member_accounts where member_id = old.id) then
      raise exception using errcode = 'P0001', message = '계정과 연결된 멤버입니다. 권한 관리에서 해당 계정을 읽기로 바꾼 뒤 삭제하세요.';
    end if;
    return old;
  end if;
  if auth.uid() is not null and not private.is_member_admin() and (
    new.id is distinct from old.id or new.sort_order is distinct from old.sort_order
    or new.is_new is distinct from old.is_new or new.is_real is distinct from old.is_real
  ) then
    raise exception using errcode = '42501', message = '멤버 구분과 순서는 관리자만 변경할 수 있습니다. 본인 소개 항목만 수정하세요.';
  end if;
  return new;
end;
$$;
revoke all on function private.guard_member_management() from public, anon, authenticated;
drop trigger if exists members_management_guard on public.members;
create trigger members_management_guard before update or delete on public.members
  for each row execute function private.guard_member_management();

create or replace function private.touch_members()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  new.updated_at := now();
  new.updated_by := coalesce((select u.email from auth.users u where u.id = auth.uid()), '');
  return new;
end;
$$;
revoke all on function private.touch_members() from public, anon, authenticated;
drop trigger if exists members_touch on public.members;
create trigger members_touch before insert or update on public.members
  for each row execute function private.touch_members();
drop function if exists public.touch_members();

-- Account emails/permissions are deliberately not in the realtime publication.
notify pgrst, 'reload schema';
commit;
