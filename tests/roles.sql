-- Run after schema.sql / roles.sql using a postgres administrative connection.
-- This is NOT a deployment migration: it always rolls back test users and rows.
-- Example: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f tests/roles.sql
begin;
set local statement_timeout = '30s';

create function pg_temp.check_true(ok boolean, label text)
returns void language plpgsql security invoker as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;
create function pg_temp.check_denied(statement text, label text, expected text default '42501')
returns void language plpgsql security invoker as $$
begin
  begin
    execute statement;
  exception when others then
    if sqlstate = expected then raise notice 'PASS: %', label; return; end if;
    raise exception 'FAIL: %, unexpected SQLSTATE %: %', label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: %, statement was allowed', label;
end;
$$;
do $$ begin
  execute format('grant usage on schema %I to anon, authenticated', pg_my_temp_schema()::regnamespace);
end $$;

insert into auth.users(id, email, email_confirmed_at, is_anonymous, raw_user_meta_data)
values
  ('11111111-1111-4111-8111-111111111101', 'sunshine-admin-test@example.invalid', now(), false, '{}'),
  ('11111111-1111-4111-8111-111111111102', 'sunshine-member-test@example.invalid', now(), false, '{"role":"admin"}'),
  ('11111111-1111-4111-8111-111111111103', 'sunshine-viewer-test@example.invalid', now(), false, '{"role":"admin"}'),
  ('11111111-1111-4111-8111-111111111104', 'sunshine-unverified-test@example.invalid', null, false, '{}');
insert into public.members(id, name, sort_order)
values
  ('22222222-2222-4222-8222-222222222201', '권한테스트 본인', 10001),
  ('22222222-2222-4222-8222-222222222202', '권한테스트 다른멤버', 10002);
update public.member_accounts set role = 'admin' where user_id = '11111111-1111-4111-8111-111111111101';
-- A request can outlive email confirmation, e.g. after an email change.
update public.member_accounts
  set requested_member_id = '22222222-2222-4222-8222-222222222202', request_status = 'pending'
  where user_id = '11111111-1111-4111-8111-111111111104';
select pg_temp.check_true(
  (select role = 'viewer' from public.member_accounts where user_id = '11111111-1111-4111-8111-111111111102'),
  'signup defaults to viewer even with forged admin metadata');
update auth.users set email = 'sunshine-viewer-canonical@example.invalid'
  where id = '11111111-1111-4111-8111-111111111103';
select pg_temp.check_true(
  (select email = 'sunshine-viewer-canonical@example.invalid' from public.member_accounts
   where user_id = '11111111-1111-4111-8111-111111111103'), 'email follows canonical auth.users');

set local role anon;
select pg_temp.check_true((select count(*) = 2 from public.members
  where id in ('22222222-2222-4222-8222-222222222201', '22222222-2222-4222-8222-222222222202')),
  'anonymous visitor reads roster');
select pg_temp.check_denied('select updated_by from public.members', 'anonymous cannot read editor emails');
select pg_temp.check_denied('select email from public.member_accounts', 'anonymous cannot read account emails');
select pg_temp.check_denied('select * from public.list_member_accounts()', 'anonymous cannot list account confirmation states');
select pg_temp.check_denied('insert into public.members(name) values (''no'')', 'anonymous cannot insert');
select pg_temp.check_denied('update public.members set name = ''no''', 'anonymous cannot update');
select pg_temp.check_denied('delete from public.members', 'anonymous cannot delete');
select pg_temp.check_denied($$select public.request_member_access('22222222-2222-4222-8222-222222222201')$$,
  'anonymous cannot request access');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111103","role":"authenticated","user_metadata":{"role":"admin"}}', true);
select pg_temp.check_true((select count(*) = 1 from public.member_accounts), 'viewer sees only own account');
select pg_temp.check_denied('select * from public.list_member_accounts()', 'viewer cannot list account confirmation states');
select pg_temp.check_denied('select * from private.list_member_accounts()', 'viewer cannot bypass account list wrapper');
select pg_temp.check_denied('select updated_by from public.members', 'signed-in viewer cannot read editor emails');
select pg_temp.check_denied('update public.member_accounts set role = ''admin''', 'direct self-elevation is denied');
select pg_temp.check_denied($$select public.admin_set_member_access('11111111-1111-4111-8111-111111111103', 'admin')$$,
  'viewer cannot call administrator assignment');
with changed as (update public.members set company = 'no' where id = '22222222-2222-4222-8222-222222222201' returning id)
select pg_temp.check_true((select count(*) = 0 from changed), 'viewer update reaches no rows');
select pg_temp.check_denied('insert into public.members(name) values (''no'')', 'viewer cannot insert');
with changed as (delete from public.members where id = '22222222-2222-4222-8222-222222222201' returning id)
select pg_temp.check_true((select count(*) = 0 from changed), 'viewer delete reaches no rows');
select pg_temp.check_true(
  public.request_member_access('22222222-2222-4222-8222-222222222202')->>'request_status' = 'pending',
  'verified viewer can request own member connection');
select pg_temp.check_true((select role = 'viewer' and member_id is null from public.member_accounts),
  'pending request grants no edit access');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111104","role":"authenticated"}', true);
select pg_temp.check_denied($$select public.request_member_access('22222222-2222-4222-8222-222222222201')$$,
  'unverified account cannot request access');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111101","role":"authenticated"}', true);
select pg_temp.check_true((select count(*) >= 4 from public.member_accounts), 'admin can see accounts');
select pg_temp.check_true((select count(*) = 4 from public.list_member_accounts()
  where user_id in ('11111111-1111-4111-8111-111111111101', '11111111-1111-4111-8111-111111111102',
                    '11111111-1111-4111-8111-111111111103', '11111111-1111-4111-8111-111111111104')),
  'admin can list all test accounts');
select pg_temp.check_true((select email_confirmed from public.list_member_accounts()
  where user_id = '11111111-1111-4111-8111-111111111102'), 'account list marks verified account confirmed');
select pg_temp.check_true((select not email_confirmed from public.list_member_accounts()
  where user_id = '11111111-1111-4111-8111-111111111104'), 'account list marks unverified account unconfirmed');
select pg_temp.check_denied('select email_confirmed_at from auth.users', 'account listing does not expose auth.users');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111102', 'admin')->>'role' = 'admin',
  'admin promotes verified viewer to administrator');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111102', 'member', '22222222-2222-4222-8222-222222222201')->>'role' = 'member',
  'admin changes verified administrator to assigned member');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111102', 'admin')->>'role' = 'admin',
  'admin promotes verified member to administrator');
select pg_temp.check_true((select member_id is null from public.member_accounts
  where user_id = '11111111-1111-4111-8111-111111111102'), 'administrator promotion clears member connection');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111102', 'member', '22222222-2222-4222-8222-222222222201')->>'role' = 'member',
  'admin can reassign promoted account to member');
select pg_temp.check_denied($$select public.admin_set_member_access('11111111-1111-4111-8111-111111111103', 'member', '22222222-2222-4222-8222-222222222201')$$,
  'duplicate member ownership is rejected', 'P0001');
select pg_temp.check_denied($$select public.admin_set_member_access('11111111-1111-4111-8111-111111111104', 'admin')$$,
  'admin cannot approve unverified account', 'P0001');
select pg_temp.check_denied($$select public.admin_set_member_access('11111111-1111-4111-8111-111111111104', 'member', '22222222-2222-4222-8222-222222222202')$$,
  'admin cannot grant member access to unverified account', 'P0001');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111104', 'viewer')->>'request_status' = 'rejected',
  'admin can reject an unverified account request');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111104', 'viewer')->>'role' = 'viewer',
  'admin can save read-only access for an unverified account');
select pg_temp.check_true(
  public.admin_set_member_access('11111111-1111-4111-8111-111111111103', 'viewer')->>'request_status' = 'rejected',
  'admin can reject pending request');
select pg_temp.check_denied($$delete from public.members where id = '22222222-2222-4222-8222-222222222201'$$,
  'linked member deletion requires prior account unlink', 'P0001');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111102","role":"authenticated"}', true);
select pg_temp.check_denied('select * from public.list_member_accounts()', 'member cannot list account confirmation states');
with changed as (update public.members set company = '본인 수정 성공' where id = '22222222-2222-4222-8222-222222222201' returning id)
select pg_temp.check_true((select count(*) = 1 from changed), 'member edits assigned row');
with changed as (update public.members set company = 'no' where id = '22222222-2222-4222-8222-222222222202' returning id)
select pg_temp.check_true((select count(*) = 0 from changed), 'member cannot edit another row');
select pg_temp.check_denied($$update public.members set is_new = true where id = '22222222-2222-4222-8222-222222222201'$$,
  'member cannot change management flag');
select pg_temp.check_denied($$update public.members set is_real = true where id = '22222222-2222-4222-8222-222222222201'$$,
  'member cannot change verified-data flag');
select pg_temp.check_denied($$update public.members set sort_order = 0 where id = '22222222-2222-4222-8222-222222222201'$$,
  'member cannot change roster order');
select pg_temp.check_denied($$update public.members set id = '22222222-2222-4222-8222-222222222209' where id = '22222222-2222-4222-8222-222222222201'$$,
  'member cannot change row identity');
select pg_temp.check_denied('insert into public.members(name) values (''no'')', 'member cannot insert');
with changed as (delete from public.members where id = '22222222-2222-4222-8222-222222222201' returning id)
select pg_temp.check_true((select count(*) = 0 from changed), 'member cannot delete own row');
select pg_temp.check_denied($$select public.request_member_access('22222222-2222-4222-8222-222222222202')$$,
  'member cannot change own association by request');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111101","role":"authenticated"}', true);
with changed as (insert into public.members(id, name) values ('22222222-2222-4222-8222-222222222203', '관리자 추가') returning id)
select pg_temp.check_true((select count(*) = 1 from changed), 'admin inserts roster row');
with changed as (update public.members set is_new = true where id = '22222222-2222-4222-8222-222222222203' returning id)
select pg_temp.check_true((select count(*) = 1 from changed), 'admin edits management flag');
with changed as (delete from public.members where id = '22222222-2222-4222-8222-222222222203' returning id)
select pg_temp.check_true((select count(*) = 1 from changed), 'admin deletes unlinked row');
do $$ begin
  if (select count(*) from public.member_accounts where role = 'admin') = 1 then
    perform pg_temp.check_denied($q$select public.admin_set_member_access('11111111-1111-4111-8111-111111111101', 'viewer')$q$,
      'last administrator cannot demote self', 'P0001');
  else
    raise notice 'SKIP: last-admin scenario (pre-existing admins kept unchanged; test in isolated database)';
  end if;
end $$;
reset role;
update auth.users set email_confirmed_at = null where id = '11111111-1111-4111-8111-111111111102';
set local role authenticated;
select public.admin_set_member_access('11111111-1111-4111-8111-111111111102', 'viewer');
select pg_temp.check_true((select role = 'viewer' and member_id is null from public.member_accounts
  where user_id = '11111111-1111-4111-8111-111111111102'), 'admin can revoke member access after target becomes unverified');
reset role;
update auth.users set email_confirmed_at = now() where id = '11111111-1111-4111-8111-111111111102';
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111102","role":"authenticated"}', true);
with changed as (update public.members set company = 'no' where id = '22222222-2222-4222-8222-222222222201' returning id)
select pg_temp.check_true((select count(*) = 0 from changed), 'revocation applies immediately with same JWT');

reset role;
do $$ begin
  if (select count(*) from public.member_accounts where role = 'admin') = 1 then
    perform pg_temp.check_denied($q$delete from auth.users where id = '11111111-1111-4111-8111-111111111101'$q$,
      'last administrator cannot be removed through auth.users cascade', 'P0001');
  end if;
end $$;
select pg_temp.check_true(
  (select updated_by = 'sunshine-member-test@example.invalid' from public.members where id = '22222222-2222-4222-8222-222222222201'),
  'audit email is canonical and retained for privileged reads');
select pg_temp.check_true(not exists (
  select 1 from pg_publication_tables where pubname = 'supabase_realtime'
    and schemaname = 'public' and tablename = 'member_accounts'), 'account emails are not published to realtime');
rollback;
