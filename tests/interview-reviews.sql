-- Isolated PostgreSQL/Supabase-compatible tests; every fixture rolls back.
begin;
set local statement_timeout='30s';
create function pg_temp.review_check(ok boolean,label text)
returns void language plpgsql security invoker as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
create function pg_temp.review_denied(statement text,label text,expected text default '42501')
returns void language plpgsql security invoker as $$ begin
  begin execute statement; exception when others then
    if sqlstate=expected then raise notice 'PASS: %',label; return; end if;
    raise exception 'FAIL: %, unexpected %: %',label,sqlstate,sqlerrm;
  end;
  raise exception 'FAIL: %, statement was allowed',label;
end $$;
create temporary table review_test_state(key text primary key,value jsonb);
grant select,insert,update on review_test_state to authenticated;
do $$ begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace); end $$;
insert into auth.users(id,email,email_confirmed_at,is_anonymous,raw_user_meta_data) values
('33333333-3333-4333-8333-333333333301','integrated-admin@example.invalid',now(),false,'{}'),
('33333333-3333-4333-8333-333333333302','integrated-member@example.invalid',now(),false,'{"role":"admin"}');
insert into public.members(id,name,company,customers,synergies,wants) values
('44444444-4444-4444-8444-444444444401','통합 멤버','기존 회사',array['기존 고객'],'{}','보존할 비지터'),
('44444444-4444-4444-8444-444444444402','다른 멤버','','{}','{}','');
update public.member_accounts set role='admin' where user_id='33333333-3333-4333-8333-333333333301';
update public.member_accounts set role='member',member_id='44444444-4444-4444-8444-444444444401' where user_id='33333333-3333-4333-8333-333333333302';
insert into private.member_details(member_id,good_referral,triggers,customer_companies) values
('44444444-4444-4444-8444-444444444401','보존할 비공개',array['기존 트리거'],array['Acme']);
insert into storage.objects(bucket_id,name,metadata) values
('member-interviews','44444444-4444-4444-8444-444444444401/profile.txt','{"size":100,"mimetype":"text/plain"}'),
('member-interviews','44444444-4444-4444-8444-444444444401/credibility.txt','{"size":100,"mimetype":"text/plain"}'),
('member-interviews','44444444-4444-4444-8444-444444444401/profitability.txt','{"size":100,"mimetype":"text/plain"}'),
('member-interviews','44444444-4444-4444-8444-444444444402/other.txt','{"size":100,"mimetype":"text/plain"}');
set local role anon;
select pg_temp.review_denied('select * from private.member_interview_reviews','anonymous cannot read review table');
select pg_temp.review_denied($q$select public.list_member_interview_reviews('44444444-4444-4444-8444-444444444401')$q$,'anonymous cannot call review RPC');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333302","role":"authenticated","user_metadata":{"role":"admin"}}',true);
select pg_temp.review_denied($q$select public.list_member_interview_reviews('44444444-4444-4444-8444-444444444401')$q$,'linked member cannot read own reviews or forge admin metadata');
select pg_temp.review_denied('select * from private.member_interview_review_history','authenticated has no review history table grant');
select pg_temp.review_denied($q$select private.merge_interview_list('{}','[]')$q$,'internal merge helper is not callable');
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333301","role":"authenticated"}',true);
insert into review_test_state values
('d1',public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/profile.txt','121 신상명세표.txt')),
('d2',public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/credibility.txt','121 신뢰 단계.txt')),
('other',public.create_member_interview('44444444-4444-4444-8444-444444444402','44444444-4444-4444-8444-444444444402/other.txt','다른 멤버.txt'));
select pg_temp.review_check((select value->'stages'='["profile"]'::jsonb from review_test_state where key='d1')
  and (select value->'stages'='["credibility"]'::jsonb from review_test_state where key='d2'),'filename infers profile and credibility stages');
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,1,'{"raw_text":"아는 단계 Visibility 고객: 신규 고객 A"}') where key='d1';
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,1,'{"raw_text":"신뢰 단계 Credibility: 함께 일할 회계사"}') where key='d2';
select pg_temp.review_check((select value->'stages'='["profile","visibility"]'::jsonb from review_test_state where key='d1'),'body and filename combine multiple stages');
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis(array[(select (value->>'id')::uuid from review_test_state where key='d1'),(select (value->>'id')::uuid from review_test_state where key='other')])$q$,'mixed members cannot be analyzed together','22023');
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis('{}')$q$,'empty source selection is rejected','22023');
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis(array[(value->>'id')::uuid,(value->>'id')::uuid]) from review_test_state where key='d1'$q$,'duplicate source ids are rejected','22023');
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis(array(select gen_random_uuid() from generate_series(1,21)))$q$,'analysis batch is bounded at twenty documents','22023');
select pg_temp.review_denied($q$select public.save_member_interview_draft((value->>'id')::uuid,2,'{"stages":["invalid"]}') from review_test_state where key='d1'$q$,'invalid stage tags are rejected','22023');
insert into review_test_state select 'start',public.begin_member_interview_review_analysis(array_agg((value->>'id')::uuid order by key)) from review_test_state where key in ('d1','d2');
select pg_temp.review_check((select jsonb_array_length(value->'documents')=2 and value->'review'->>'revision'='1' and value?'lease_id' from review_test_state where key='start'),'two uploaded documents start a single member review');
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis(array[(value->>'id')::uuid]) from review_test_state where key='d1'$q$,'member-wide lease prevents second overlapping analysis','55000');
select pg_temp.review_denied($q$select public.begin_member_interview_analysis((value->>'id')::uuid,2) from review_test_state where key='d2'$q$,'legacy analysis cannot bypass active member lease','55000');
select pg_temp.review_check((select public.cancel_member_interview_review_analysis((value->'review'->>'id')::uuid,'00000000-0000-4000-8000-000000000000')->>'released'='false' from review_test_state where key='start'),'wrong lease cannot cancel another analysis');
select pg_temp.review_denied($q$select public.finish_member_interview_review_analysis((value->'review'->>'id')::uuid,1,(value->>'lease_id')::uuid,'{"suggestions":[{"key":"customers","value":["bad"],"sources":["00000000-0000-4000-8000-000000000000"]}]}') from review_test_state where key='start'$q$,'foreign evidence ids are rejected','22023');
select pg_temp.review_denied($q$select public.finish_member_interview_review_analysis((value->'review'->>'id')::uuid,1,(value->>'lease_id')::uuid,'{"suggestions":[{"key":"customers","value":["bad"],"sources":[]}]}') from review_test_state where key='start'$q$,'every proposal requires evidence','22023');
insert into review_test_state select 'r1',public.finish_member_interview_review_analysis((s.value->'review'->>'id')::uuid,1,(s.value->>'lease_id')::uuid,
  jsonb_build_object('extracted',jsonb_build_object('summary','two sources','warnings','[]'::jsonb,'suggestions',jsonb_build_array(
    jsonb_build_object('key','customers','value',jsonb_build_array('신규 고객 A'),'sources',jsonb_build_array(d1.value->>'id')),
    jsonb_build_object('key','synergies','value',jsonb_build_array('회계사'),'sources',jsonb_build_array(d2.value->>'id')))),
    'public_patch',jsonb_build_object('wants','unapproved'),'private_patch','{}'::jsonb))
  from review_test_state s,review_test_state d1,review_test_state d2 where s.key='start' and d1.key='d1' and d2.key='d2';
select pg_temp.review_check((select jsonb_array_length(value->'extracted'->'suggestions')=2 and value->'public_patch'='{}'::jsonb and value->'private_patch'='{}'::jsonb from review_test_state where key='r1'),'completed integrated analysis keeps both document citations and no unapproved patches');
select pg_temp.review_check((select bool_and(d->>'usage_status'='analyzed') from jsonb_array_elements(public.list_member_interviews('44444444-4444-4444-8444-444444444401')) d),'documents show included in analysis');
update review_test_state set value=public.save_member_interview_review((value->>'id')::uuid,2,'{"public_patch":{"customers":["신규 고객 A"],"synergies":["회계사"]},"private_patch":{"triggers":["새 트리거"]},"list_modes":{"customers":"append"}}') where key='r1';
select pg_temp.review_denied($q$select public.save_member_interview_review((value->>'id')::uuid,2,'{"public_patch":{}}') from review_test_state where key='r1'$q$,'stale review save cannot erase newer selections','40001');
select pg_temp.review_denied($q$select public.apply_member_interview_review((value->>'id')::uuid,3,'2000-01-01','{"customers":["lost"]}','{}') from review_test_state where key='r1'$q$,'member CAS rejects stale apply','40001');
update review_test_state s set value=public.apply_member_interview_review((s.value->>'id')::uuid,3,m.updated_at,'{"customers":["신규 고객 A"],"synergies":["회계사"]}','{"triggers":["새 트리거"],"customer_companies":[" acme ","New Company"]}')
  from public.members m where s.key='r1' and m.id='44444444-4444-4444-8444-444444444401';
select pg_temp.review_check((select customers=array['기존 고객','신규 고객 A'] and synergies=array['회계사'] and wants='보존할 비지터' and company='기존 회사'
  from public.members where id='44444444-4444-4444-8444-444444444401') and public.get_member_details('44444444-4444-4444-8444-444444444401')->0->'triggers'='["기존 트리거","새 트리거"]'::jsonb
  and public.get_member_details('44444444-4444-4444-8444-444444444401')->0->'customer_companies'='["Acme","New Company"]'::jsonb,'first apply appends all list types, deduplicates case/whitespace and preserves unselected scalars');
select pg_temp.review_check((select bool_and(d->>'usage_status'='applied') from jsonb_array_elements(public.list_member_interviews('44444444-4444-4444-8444-444444444401')) d),'source documents show used in an applied review');
insert into review_test_state values ('d3',public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/profitability.txt','121 수익 단계 Profitability.txt'));
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,1,'{"raw_text":"수익 단계: 신규 고객 B, 신규 트리거"}') where key='d3';
select pg_temp.review_check((select public.get_member_interview_review((value->>'id')::uuid)->>'has_new_documents'='true' from review_test_state where key='r1'),'third upload flags new documents on prior applied review');
reset role;
update private.member_interview_reviews set analysis_started_at=clock_timestamp()-interval '1 minute';
set local role authenticated;
update review_test_state set value=(select public.begin_member_interview_review_analysis(array_agg((d.value->>'id')::uuid order by d.key)) from review_test_state d where d.key in ('d1','d2','d3')) where key='start';
insert into review_test_state select 'r2',public.finish_member_interview_review_analysis((s.value->'review'->>'id')::uuid,1,(s.value->>'lease_id')::uuid,
  jsonb_build_object('suggestions',jsonb_build_array(jsonb_build_object('key','customers','value',jsonb_build_array('신규 고객 A','신규 고객 B'),'sources',jsonb_build_array(d1.value->>'id',d3.value->>'id')))))
  from review_test_state s,review_test_state d1,review_test_state d3 where s.key='start' and d1.key='d1' and d3.key='d3';
update review_test_state s set value=public.apply_member_interview_review((s.value->>'id')::uuid,2,m.updated_at,'{"customers":[" 신규고객A ","신규 고객 B"]}','{"triggers":["신규 트리거"]}')
  from public.members m where s.key='r2' and m.id='44444444-4444-4444-8444-444444444401';
select pg_temp.review_check((select customers=array['기존 고객','신규 고객 A','신규 고객 B'] and synergies=array['회계사'] from public.members where id='44444444-4444-4444-8444-444444444401')
  and public.get_member_details('44444444-4444-4444-8444-444444444401')->0->'triggers'='["기존 트리거","새 트리거","신규 트리거"]'::jsonb,'three-document reanalysis adds new items without losing either prior apply');
reset role;
update private.member_interview_reviews set analysis_started_at=clock_timestamp()-interval '1 minute';
-- A pre-upgrade applied document remains eligible for source editing/reanalysis.
update private.member_interviews set status='applied',applied_at=clock_timestamp() where id=(select (value->>'id')::uuid from review_test_state where key='d1');
set local role authenticated;
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,2,'{"stages":[],"raw_text":"신상명세표 Visibility 수정 원문"}') where key='d1';
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,3,'{"raw_text":"신상명세표 Visibility 다시 수정"}') where key='d1';
select pg_temp.review_check((select value->'stages'='[]'::jsonb and value->>'status'='applied' and value->>'revision'='4' from review_test_state where key='d1'),'legacy applied source can be edited and explicit empty stage tags persist');
update review_test_state set value=(select public.begin_member_interview_review_analysis(array_agg((d.value->>'id')::uuid order by d.key)) from review_test_state d where d.key in ('d1','d2','d3')) where key='start';
insert into review_test_state select 'r3',public.finish_member_interview_review_analysis((value->'review'->>'id')::uuid,1,(value->>'lease_id')::uuid,'{"suggestions":[]}') from review_test_state where key='start';
update review_test_state s set value=public.apply_member_interview_review((s.value->>'id')::uuid,2,m.updated_at,'{"customers":["의도한 교체"]}','{"triggers":[]}', '{"customers":"replace","triggers":"replace"}')
  from public.members m where s.key='r3' and m.id='44444444-4444-4444-8444-444444444401';
select pg_temp.review_check((select customers=array['의도한 교체'] and synergies=array['회계사'] from public.members where id='44444444-4444-4444-8444-444444444401')
  and public.get_member_details('44444444-4444-4444-8444-444444444401')->0->'triggers'='[]'::jsonb,'explicit replace replaces only selected lists, including deliberate empty list');
reset role;
update private.member_interview_reviews set analysis_started_at=clock_timestamp()-interval '1 minute';
set local role authenticated;
update review_test_state set value=(select public.begin_member_interview_review_analysis(array[(d.value->>'id')::uuid]) from review_test_state d where d.key='d1') where key='start';
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,4,'{"raw_text":"changed while AI was running"}') where key='d1';
select pg_temp.review_denied($q$select public.finish_member_interview_review_analysis((value->'review'->>'id')::uuid,1,(value->>'lease_id')::uuid,'{"suggestions":[]}') from review_test_state where key='start'$q$,'source revision change rejects delayed AI result','40001');
select pg_temp.review_check((select public.cancel_member_interview_review_analysis((value->'review'->>'id')::uuid,(value->>'lease_id')::uuid)->>'released'='true' from review_test_state where key='start'),'cancel releases only the owned analysis lease');
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis(array[(value->>'id')::uuid]) from review_test_state where key='d1'$q$,'cancelled paid request retains member cooldown','55000');
reset role;
update private.member_interview_reviews set analysis_started_at=clock_timestamp()-interval '1 minute';
set local role authenticated;
update review_test_state set value=(select public.begin_member_interview_review_analysis(array[(d.value->>'id')::uuid]) from review_test_state d where d.key='d2') where key='start';
reset role;
update private.member_interview_reviews set analysis_expires_at=clock_timestamp()-interval '1 second' where id=(select (value->'review'->>'id')::uuid from review_test_state where key='start');
set local role authenticated;
select pg_temp.review_denied($q$select public.finish_member_interview_review_analysis((value->'review'->>'id')::uuid,1,(value->>'lease_id')::uuid,'{"suggestions":[]}') from review_test_state where key='start'$q$,'expired lease cannot store delayed analysis','40001');
select public.cancel_member_interview_review_analysis((value->'review'->>'id')::uuid,(value->>'lease_id')::uuid) from review_test_state where key='start';
reset role;
update private.member_interview_reviews set analysis_started_at=clock_timestamp()-interval '1 minute';
set local role authenticated;
update review_test_state set value=(select public.begin_member_interview_review_analysis(array[(d.value->>'id')::uuid]) from review_test_state d where d.key='d2') where key='start';
insert into review_test_state select 'stale',public.finish_member_interview_review_analysis((value->'review'->>'id')::uuid,1,(value->>'lease_id')::uuid,'{"suggestions":[]}') from review_test_state where key='start';
update review_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,2,'{"stages":["credibility","profitability"]}') where key='d2';
select pg_temp.review_denied($q$select public.apply_member_interview_review((s.value->>'id')::uuid,2,m.updated_at,'{"customers":["outdated"]}','{}') from review_test_state s,public.members m where s.key='stale' and m.id='44444444-4444-4444-8444-444444444401'$q$,'source edit after analysis invalidates apply as well as analysis finish','40001');
select pg_temp.review_check((select public.get_member_interview_review((value->>'id')::uuid)->>'sources_stale'='true' from review_test_state where key='stale'),'review snapshot exposes changed-source warning');
reset role;
savepoint aggregate_limit;
update private.member_interviews set raw_text=repeat('x',90000) where member_id='44444444-4444-4444-8444-444444444401';
set local role authenticated;
select pg_temp.review_denied($q$select public.begin_member_interview_review_analysis(array_agg((value->>'id')::uuid)) from review_test_state where key in ('d1','d2','d3')$q$,'aggregate source text cannot exceed 240000 characters','22023');
reset role;
rollback to savepoint aggregate_limit;
release savepoint aggregate_limit;
set local role authenticated;
select pg_temp.review_check((select jsonb_array_length(public.get_member_interview_review((value->>'id')::uuid)->'history')=4 from review_test_state where key='r1'),'private audit preserves created, analyzed, saved and applied snapshots');
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333302","role":"authenticated"}',true);
select pg_temp.review_denied($q$select public.get_member_interview_review((value->>'id')::uuid) from review_test_state where key='r1'$q$,'member cannot read applied review or audit');
reset role;
select pg_temp.review_check(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
  and p.proname in ('begin_member_interview_review_analysis','finish_member_interview_review_analysis','cancel_member_interview_review_analysis','list_member_interview_reviews','get_member_interview_review','save_member_interview_review','apply_member_interview_review') and p.prosecdef),'all review RPC wrappers are security invoker');
select pg_temp.review_check(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='private'
  and tablename in ('member_interview_reviews','member_interview_review_history')),'private reviews and histories are absent from realtime');
rollback;
