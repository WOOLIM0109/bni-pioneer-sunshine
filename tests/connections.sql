-- Isolated PostgreSQL/Supabase-compatible checks after schema.sql + connections.sql.
-- Synthetic users, members, links and temporary helpers are rolled back.
begin;
set local statement_timeout = '30s';

create function pg_temp.connection_check(ok boolean, label text)
returns void language plpgsql security invoker as $$
begin
  if ok is distinct from true then raise exception 'FAIL: %', label; end if;
  raise notice 'PASS: %', label;
end;
$$;
create function pg_temp.connection_denied(statement text, label text, expected text default '42501', expected_message text default null)
returns void language plpgsql security invoker as $$
begin
  begin execute statement;
  exception when others then
    if sqlstate = expected then
      if expected_message is not null and sqlerrm <> expected_message then
        raise exception 'FAIL: %, wrong error message: %', label, sqlerrm;
      end if;
      raise notice 'PASS: %', label; return;
    end if;
    raise exception 'FAIL: %, unexpected %: %', label, sqlstate, sqlerrm;
  end;
  raise exception 'FAIL: %, statement was allowed', label;
end;
$$;
create temporary table connection_test_state(key text primary key, value jsonb);
grant select, insert, update on connection_test_state to authenticated;
do $$ begin execute format('grant usage on schema %I to anon,authenticated', pg_my_temp_schema()::regnamespace); end $$;

insert into auth.users(id,email,email_confirmed_at,is_anonymous,raw_user_meta_data) values
('55555555-5555-4555-8555-555555555501','connection-admin@example.invalid',now(),false,'{}'),
('55555555-5555-4555-8555-555555555502','connection-member@example.invalid',now(),false,'{"role":"admin"}'),
('55555555-5555-4555-8555-555555555503','connection-viewer@example.invalid',now(),false,'{"role":"admin"}'),
('55555555-5555-4555-8555-555555555504','connection-unconfirmed@example.invalid',null,false,'{}'),
('55555555-5555-4555-8555-555555555505','connection-anonymous@example.invalid',now(),true,'{}');
insert into public.members(id,name,company,field,synergies) values
('66666666-6666-4666-8666-666666666601','연결 원본','원본 회사','경영컨설팅',array['홈페이지 제작','브랜딩 전문가','  원문 · 공백  ','constructor',repeat('가',1000)]),
('66666666-6666-4666-8666-666666666602','동명이인','첫 번째 회사','앱·웹개발','{}'),
('66666666-6666-4666-8666-666666666603','동명이인','두 번째 회사','온라인마케팅','{}'),
('66666666-6666-4666-8666-666666666604','삭제할 원본','삭제 원본 회사','기타',array['삭제 테스트',
  (select string_agg(chr(44032+mod(i*7919,11172)),'' order by i) from generate_series(0,999) i),
  (select string_agg(chr(126976+mod(('x'||substr(md5(i::text),1,8))::bit(32)::bigint,2816)::int),'' order by i) from generate_series(0,999) i)]),
('66666666-6666-4666-8666-666666666605','삭제할 상대','삭제 상대 회사','기타','{}');
update public.member_accounts set role='admin'
  where user_id in ('55555555-5555-4555-8555-555555555501','55555555-5555-4555-8555-555555555504','55555555-5555-4555-8555-555555555505');
update public.member_accounts set role='member',member_id='66666666-6666-4666-8666-666666666601'
  where user_id='55555555-5555-4555-8555-555555555502';
insert into public.member_synergy_links(source_member_id,synergy,target_member_id) values
('66666666-6666-4666-8666-666666666604','삭제 테스트','66666666-6666-4666-8666-666666666605');
insert into connection_test_state
  select 'source',jsonb_build_object('updated_at',updated_at,'synergies',synergies)
  from public.members where id='66666666-6666-4666-8666-666666666601';
insert into connection_test_state
  select 'longsource',jsonb_build_object('updated_at',updated_at,'synergies',synergies)
  from public.members where id='66666666-6666-4666-8666-666666666604';

select pg_temp.connection_check((select relrowsecurity from pg_class where oid='public.member_synergy_links'::regclass),'link table has RLS enabled');
select pg_temp.connection_check((select not prosecdef from pg_proc where oid='public.set_member_synergy_link(uuid,text,uuid,timestamptz,timestamptz)'::regprocedure),'public link RPC is an invoker wrapper');
select pg_temp.connection_check((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid='private.sunshine_set_member_synergy_link(uuid,text,uuid,timestamptz,timestamptz)'::regprocedure),'private link implementation has an empty search path');
select pg_temp.connection_check(not has_function_privilege('anon','public.set_member_synergy_link(uuid,text,uuid,timestamptz,timestamptz)','EXECUTE'),'anonymous has no RPC execute grant');
select pg_temp.connection_check(not has_function_privilege('anon','private.sunshine_set_member_synergy_link(uuid,text,uuid,timestamptz,timestamptz)','EXECUTE'),'anonymous has no private helper execute grant');
select pg_temp.connection_check(not has_table_privilege('authenticated','public.member_synergy_links','INSERT,UPDATE,DELETE'),'authenticated has no direct link writes');
select pg_temp.connection_check((select count(*)=1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename='member_synergy_links'),'links are in the realtime publication exactly once');

set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.connection_check((select count(*)=1 from public.member_synergy_links),'anonymous reads confirmed links');
select pg_temp.connection_check((select target_member_id='66666666-6666-4666-8666-666666666605'::uuid from public.member_synergy_links),'anonymous reads the actual target UUID');
select pg_temp.connection_denied($q$insert into public.member_synergy_links values ('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now())$q$,'anonymous direct insert denied');
select pg_temp.connection_denied($q$update public.member_synergy_links set target_member_id='66666666-6666-4666-8666-666666666602'$q$,'anonymous direct update denied');
select pg_temp.connection_denied('delete from public.member_synergy_links','anonymous direct delete denied');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null)$q$,'anonymous cannot invoke the mutation RPC');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555503","role":"authenticated","user_metadata":{"role":"admin"}}',true);
select pg_temp.connection_check((select count(*)=1 from public.member_synergy_links),'viewer can read confirmed links');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null)$q$,'viewer forged admin metadata cannot confirm a link');
select pg_temp.connection_denied($q$select private.sunshine_set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작',null,now(),null)$q$,'private helper checks viewer permissions too');
select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555502","role":"authenticated","user_metadata":{"role":"admin"}}',true);
select pg_temp.connection_check((select count(*)=1 from public.member_synergy_links),'member can read confirmed links');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null)$q$,'member cannot confirm even their own synergy link');
select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555504","role":"authenticated"}',true);
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null)$q$,'unconfirmed database admin is denied');
select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555505","role":"authenticated"}',true);
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null)$q$,'anonymous auth user with an admin row is denied');
select set_config('request.jwt.claims','{"role":"authenticated"}',true);
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null)$q$,'missing authenticated user is denied');

select set_config('request.jwt.claims','{"sub":"55555555-5555-4555-8555-555555555501","role":"authenticated"}',true);
select pg_temp.connection_denied($q$insert into public.member_synergy_links values ('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now())$q$,'admin cannot bypass RPC with direct insert');
select pg_temp.connection_denied($q$update public.member_synergy_links set target_member_id='66666666-6666-4666-8666-666666666602'$q$,'admin cannot bypass CAS with direct update');
select pg_temp.connection_denied('delete from public.member_synergy_links','admin cannot bypass CAS with direct delete');
select pg_temp.connection_denied($q$select public.set_member_synergy_link(null,'홈페이지 제작',null,now(),null)$q$,'null source rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601',null,null,now(),null)$q$,'null synergy rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','',null,now(),null)$q$,'empty synergy rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601',repeat('가',1001),null,now(),null)$q$,'synergy longer than 1000 characters rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666604',m.synergies[2],'66666666-6666-4666-8666-666666666602',m.updated_at,null) from public.members m where m.id='66666666-6666-4666-8666-666666666604'$q$,'unindexable Korean text returns actionable Korean validation feedback','22023','상생직군 문구가 너무 깁니다. 멤버 정보에서 업종명만 짧게 정리한 뒤 다시 연결하세요.');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666604',m.synergies[3],'66666666-6666-4666-8666-666666666602',m.updated_at,null) from public.members m where m.id='66666666-6666-4666-8666-666666666604'$q$,'unindexable emoji-range text returns actionable Korean validation feedback','22023','상생직군 문구가 너무 깁니다. 멤버 정보에서 업종명만 짧게 정리한 뒤 다시 연결하세요.');
select pg_temp.connection_check((select to_jsonb(m.synergies)=s.value->'synergies' and m.updated_at=(s.value->>'updated_at')::timestamptz
  from public.members m,connection_test_state s where m.id='66666666-6666-4666-8666-666666666604' and s.key='longsource'),'oversized index keys leave all original wording and member version unchanged');
select pg_temp.connection_check((select count(*)=1 and bool_and(synergy='삭제 테스트' and target_member_id='66666666-6666-4666-8666-666666666605'::uuid)
  from public.member_synergy_links where source_member_id='66666666-6666-4666-8666-666666666604'),'oversized index keys neither change existing mappings nor insert a truncated key');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작',null,null,null)$q$,'missing source version rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666699','홈페이지 제작',null,now(),null)$q$,'missing source member rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666601',now(),null)$q$,'self link rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','목록에 없는 직군','66666666-6666-4666-8666-666666666602',now(),null)$q$,'synergy must still occur in source member data','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','원문 · 공백','66666666-6666-4666-8666-666666666602',now(),null)$q$,'synergy comparison does not silently trim original text','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666699',now(),null)$q$,'missing target member rejected','22023');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now()-interval '1 second',null)$q$,'stale source version rejects new link','40001');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),now())$q$,'expected existing link cannot silently insert a missing mapping','40001');

insert into connection_test_state values ('first',public.set_member_synergy_link(
  '66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),null));
select pg_temp.connection_check((select value->>'source_member_id'='66666666-6666-4666-8666-666666666601' and value->>'synergy'='홈페이지 제작'
  and value->>'target_member_id'='66666666-6666-4666-8666-666666666602' and value?'updated_at' from connection_test_state where key='first'),'admin confirmation returns the complete public mapping');
select pg_temp.connection_check((select count(*)=4 from connection_test_state s cross join lateral jsonb_object_keys(s.value) where s.key='first'),'returned mapping contains no private account or document fields');
select pg_temp.connection_check((select m.synergies= array['홈페이지 제작','브랜딩 전문가','  원문 · 공백  ','constructor',repeat('가',1000)]
  and m.updated_at=(s.value->>'updated_at')::timestamptz from public.members m,connection_test_state s
  where m.id='66666666-6666-4666-8666-666666666601' and s.key='source'),'mapping preserves source synergy wording and member version');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666603',now(),null)$q$,'expected absent cannot overwrite a confirmed link','40001');
insert into connection_test_state select 'second',public.set_member_synergy_link(
  '66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666603',now(),(value->>'updated_at')::timestamptz)
  from connection_test_state where key='first';
select pg_temp.connection_check((select value->>'target_member_id'='66666666-6666-4666-8666-666666666603' from connection_test_state where key='second'),'admin can choose a specific UUID among identical names');
select pg_temp.connection_check((select (b.value->>'updated_at')::timestamptz>(a.value->>'updated_at')::timestamptz
  from connection_test_state a,connection_test_state b where a.key='first' and b.key='second'),'server link version advances within the same transaction');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),(value->>'updated_at')::timestamptz) from connection_test_state where key='first'$q$,'stale link version blocks replacement','40001');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작',null,now(),(value->>'updated_at')::timestamptz) from connection_test_state where key='first'$q$,'stale link version blocks clearing','40001');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작',null,now()-interval '1 second',(value->>'updated_at')::timestamptz) from connection_test_state where key='second'$q$,'stale source version also blocks clearing','40001');
select pg_temp.connection_check((select target_member_id='66666666-6666-4666-8666-666666666603'::uuid from public.member_synergy_links where source_member_id='66666666-6666-4666-8666-666666666601' and synergy='홈페이지 제작'),'conflicts retain the currently confirmed link');
select pg_temp.connection_check((select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작',null,now(),(value->>'updated_at')::timestamptz) is null from connection_test_state where key='second'),'admin clear returns SQL null');
select pg_temp.connection_check(not exists(select 1 from public.member_synergy_links where source_member_id='66666666-6666-4666-8666-666666666601' and synergy='홈페이지 제작'),'admin clear removes the override');
select pg_temp.connection_denied($q$select public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작','66666666-6666-4666-8666-666666666602',now(),(value->>'updated_at')::timestamptz) from connection_test_state where key='second'$q$,'cleared link cannot be silently recreated by an old confirmation','40001');
select pg_temp.connection_check(public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','홈페이지 제작',null,now(),null) is null,'clearing an expected-absent link is an idempotent no-op');
select pg_temp.connection_check(public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','  원문 · 공백  ','66666666-6666-4666-8666-666666666602',now(),null)->>'synergy'='  원문 · 공백  ','stored original synergy keeps whitespace and punctuation');
select pg_temp.connection_check(length(public.set_member_synergy_link('66666666-6666-4666-8666-666666666601',repeat('가',1000),'66666666-6666-4666-8666-666666666602',now(),null)->>'synergy')=1000,'1000-character synergy boundary is accepted');
select pg_temp.connection_check(public.set_member_synergy_link('66666666-6666-4666-8666-666666666601','constructor','66666666-6666-4666-8666-666666666602',now(),null)->>'synergy'='constructor','prototype-like synergy remains ordinary text');

set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.connection_check((select count(*)=3 from public.member_synergy_links where source_member_id='66666666-6666-4666-8666-666666666601'),'anonymous reader sees all confirmed mappings after administrator changes');

reset role;
select pg_temp.connection_denied($q$insert into public.member_synergy_links values ('66666666-6666-4666-8666-666666666601','owner-self','66666666-6666-4666-8666-666666666601',now())$q$,'table constraint also rejects self links','23514');
select pg_temp.connection_denied($q$insert into public.member_synergy_links values ('66666666-6666-4666-8666-666666666601','','66666666-6666-4666-8666-666666666602',now())$q$,'table constraint also rejects empty synergy','23514');
delete from public.members where id='66666666-6666-4666-8666-666666666602';
select pg_temp.connection_check(not exists(select 1 from public.member_synergy_links where target_member_id='66666666-6666-4666-8666-666666666602'),'deleting a target member cascades its incoming overrides');
delete from public.members where id='66666666-6666-4666-8666-666666666604';
select pg_temp.connection_check(not exists(select 1 from public.member_synergy_links where source_member_id='66666666-6666-4666-8666-666666666604'),'deleting a source member cascades its outgoing overrides');

rollback;
