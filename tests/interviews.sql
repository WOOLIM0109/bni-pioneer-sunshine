-- Run in an ISOLATED PostgreSQL/Supabase-compatible test database after
-- schema.sql + interviews.sql. All synthetic fixtures and policy changes roll back.
-- No Storage HTTP, email, or external AI request is made.
begin;
set local statement_timeout='30s';
create function pg_temp.check_true(ok boolean, label text)
returns void language plpgsql security invoker as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
create function pg_temp.check_denied(statement text,label text,expected text default '42501')
returns void language plpgsql security invoker as $$ begin
  begin execute statement;
  exception when others then
    if sqlstate=expected then raise notice 'PASS: %',label; return; end if;
    raise exception 'FAIL: %, unexpected %: %',label,sqlstate,sqlerrm;
  end;
  raise exception 'FAIL: %, statement was allowed',label;
end $$;
create temporary table interview_test_state(key text primary key,value jsonb);
grant select,insert,update on interview_test_state to authenticated;
do $$ begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace); end $$;

insert into auth.users(id,email,email_confirmed_at,is_anonymous,raw_user_meta_data) values
('33333333-3333-4333-8333-333333333301','interview-admin@example.invalid',now(),false,'{}'),
('33333333-3333-4333-8333-333333333302','interview-member@example.invalid',now(),false,'{"role":"admin"}'),
('33333333-3333-4333-8333-333333333303','interview-viewer@example.invalid',now(),false,'{"role":"admin"}'),
('33333333-3333-4333-8333-333333333304','interview-unconfirmed@example.invalid',null,false,'{}');
insert into public.members(id,name,company,customers,synergies,wants) values
('44444444-4444-4444-8444-444444444401','질문지 본인','기존 회사',array['공개 고객 유형'],array['기존 상생직군'],'기존 비지터'),
('44444444-4444-4444-8444-444444444402','질문지 타인','다른 회사',array['다른 고객 유형'],'{}','');
update public.member_accounts set role='admin' where user_id='33333333-3333-4333-8333-333333333301';
update public.member_accounts set role='member',member_id='44444444-4444-4444-8444-444444444401'
  where user_id='33333333-3333-4333-8333-333333333302';
insert into private.member_details(member_id,good_referral,triggers,customer_companies) values
('44444444-4444-4444-8444-444444444401','기존 비공개 리퍼럴',array['기존 비공개 트리거'],array['실제 고객사 A']);
insert into storage.objects(bucket_id,name,metadata) values
('member-interviews','44444444-4444-4444-8444-444444444401/document.pdf','{"size":200,"mimetype":"application/pdf"}'),
('member-interviews','44444444-4444-4444-8444-444444444401/analysis.txt','{"size":100,"mimetype":"text/plain"}'),
('member-interviews','44444444-4444-4444-8444-444444444401/oversize.pdf','{"size":20971521,"mimetype":"application/pdf"}'),
('member-interviews','44444444-4444-4444-8444-444444444401/wrong.exe','{"size":200,"mimetype":"application/octet-stream"}');
insert into storage.buckets(id,name,public) values ('sunshine-interview-test-other','sunshine-interview-test-other',false);
insert into storage.objects(bucket_id,name,metadata) values ('sunshine-interview-test-other','unrelated.txt','{"size":10,"mimetype":"text/plain"}');
-- Simulate another feature's overly broad permissive policy. The questionnaire
-- restrictive boundary must still protect its bucket without breaking other ones.
create policy sunshine_interview_test_broad on storage.objects for all to anon,authenticated using(true) with check(true);

set local role anon;
select set_config('request.jwt.claims','{"role":"anon"}',true);
select pg_temp.check_true((select count(*)=2 from public.members where id in
  ('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444402')),'anonymous public roster still works');
select pg_temp.check_true((select bool_and(good_referral='' and cardinality(triggers)=0) from public.members),'public sensitive columns remain empty');
select pg_temp.check_denied('select * from private.member_details','anonymous cannot select private details');
select pg_temp.check_denied('select public.get_member_details()','anonymous cannot call details RPC');
select pg_temp.check_denied('select public.list_member_interviews()','anonymous cannot call source RPC');
select pg_temp.check_true((select count(*)=0 from storage.objects where bucket_id='member-interviews'),'anonymous cannot read private files even with broad storage policy');
select pg_temp.check_true((select count(*)=1 from storage.objects where bucket_id='sunshine-interview-test-other'),'questionnaire boundary does not break unrelated anonymous storage policy');

set local role authenticated;
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333303","role":"authenticated","user_metadata":{"role":"admin"}}',true);
select pg_temp.check_denied('select public.get_member_details()','viewer cannot read any private details');
select pg_temp.check_denied('select public.list_member_interviews()','forged metadata cannot read documents');
select pg_temp.check_denied('select * from private.member_interviews','no direct authenticated document table grants');
select pg_temp.check_denied($q$select private.write_member_details('44444444-4444-4444-8444-444444444401','{}')$q$,'internal write helper is not callable');
select pg_temp.check_true((select count(*)=0 from storage.objects where bucket_id='member-interviews'),'viewer cannot read private bucket');
select pg_temp.check_denied($q$insert into storage.objects(bucket_id,name) values ('member-interviews','viewer.txt')$q$,'viewer cannot upload private files');
select pg_temp.check_denied($q$select public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/document.pdf','document.pdf')$q$,'viewer cannot register a document');

select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333302","role":"authenticated"}',true);
select pg_temp.check_true(jsonb_array_length(public.get_member_details())=1,'member null details lookup returns only linked self');
select pg_temp.check_true(public.get_member_details()->0->>'good_referral'='기존 비공개 리퍼럴','member can read own details');
select pg_temp.check_denied($q$select public.get_member_details('44444444-4444-4444-8444-444444444402')$q$,'member cannot read another member private details');
select pg_temp.check_denied('select public.list_member_interviews()','member cannot read even own source document');
select pg_temp.check_denied($q$select public.update_member_details('44444444-4444-4444-8444-444444444402',0,'{"good_referral":"no"}')$q$,'member cannot write another member details');
insert into interview_test_state values ('detail',public.update_member_details('44444444-4444-4444-8444-444444444401',1,'{"good_referral":"본인 수정 비공개"}'));
select pg_temp.check_true((select (value->>'revision')::bigint=2 and value->>'good_referral'='본인 수정 비공개'
  and value->'triggers'='["기존 비공개 트리거"]'::jsonb and value->'customer_companies'='["실제 고객사 A"]'::jsonb
  and value?'member_updated_at' from interview_test_state where key='detail'),'own update increments revision and preserves absent private fields');
select pg_temp.check_denied($q$select public.update_member_details('44444444-4444-4444-8444-444444444401',1,'{"good_referral":"stale"}')$q$,'stale private revision rejects overwrite','40001');
select pg_temp.check_denied($q$select public.update_member_details('44444444-4444-4444-8444-444444444401',2,'{"role":"admin"}')$q$,'private patch key allowlist enforced','22023');
select pg_temp.check_denied($q$select public.update_member_details('44444444-4444-4444-8444-444444444401',2,'{"triggers":[null]}')$q$,'private arrays reject nonstrings','22023');
select pg_temp.check_denied($q$update public.members set good_referral='leak' where id='44444444-4444-4444-8444-444444444401'$q$,'old member client cannot republish good referrals');
select pg_temp.check_denied($q$update public.members set triggers=array['leak'] where id='44444444-4444-4444-8444-444444444401'$q$,'old member client cannot republish triggers');
select pg_temp.check_true((select good_referral='' and triggers='{}'::text[] from public.members where id='44444444-4444-4444-8444-444444444401'),'private editing never copies values to public table');

select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333304","role":"authenticated"}',true);
select pg_temp.check_denied('select public.get_member_details()','unconfirmed account cannot read details');
select pg_temp.check_denied('select public.list_member_interviews()','unconfirmed account cannot read original');

select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333301","role":"authenticated"}',true);
select pg_temp.check_true(jsonb_array_length(public.get_member_details())>=2,'admin can get all member private detail rows including revision zero');
select pg_temp.check_true(public.get_member_details('44444444-4444-4444-8444-444444444402')->0->>'revision'='0','missing private row has revision zero');
select pg_temp.check_true((select count(*)=4 from storage.objects where bucket_id='member-interviews' and name like '44444444-4444-4444-8444-444444444401/%'),'admin can see original files');
select pg_temp.check_denied($q$select public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/missing.pdf','missing.pdf')$q$,'missing uploaded object rejected','22023');
select pg_temp.check_denied($q$select public.create_member_interview('44444444-4444-4444-8444-444444444402','44444444-4444-4444-8444-444444444401/document.pdf','document.pdf')$q$,'document path cannot be attached to a different member','22023');
select pg_temp.check_denied($q$select public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/oversize.pdf','small.pdf')$q$,'stored size overrides display filename','22023');
select pg_temp.check_denied($q$select public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/wrong.exe','safe.pdf')$q$,'stored mime overrides display filename','22023');
insert into interview_test_state values ('interview',public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/document.pdf','document.pdf'));
select pg_temp.check_true((select value->>'revision'='1' and value->>'status'='draft' and value->>'file_size'='200'
  and value->>'mime_type'='application/pdf' and value->>'raw_text'='' from interview_test_state where key='interview'),'admin creates draft with verified stored metadata');
select pg_temp.check_denied($q$select public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/document.pdf','document.pdf')$q$,'duplicate document path rejected','23505');
select pg_temp.check_true(not (public.list_member_interviews('44444444-4444-4444-8444-444444444401')->0 ? 'raw_text'),'document list omits full original and extraction');
update interview_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,1,
  '{"raw_text":"관리자 전용 원문 <script>synthetic</script>","extracted":{"synthetic":true},"public_patch":{"company":"검토 회사"},"private_patch":{"good_referral":"검토 비공개 리퍼럴"}}') where key='interview';
select pg_temp.check_true((select company='기존 회사' from public.members where id='44444444-4444-4444-8444-444444444401'),'draft save never applies proposed public data');
select pg_temp.check_true(public.get_member_details('44444444-4444-4444-8444-444444444401')->0->>'good_referral'='본인 수정 비공개','draft save never applies proposed private data');
update interview_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,2,'{"public_patch":{"wants":"추가 검토 비지터"}}') where key='interview';
select pg_temp.check_true((select value->'public_patch'->>'company'='검토 회사' and value->'public_patch'->>'wants'='추가 검토 비지터'
  and value->'private_patch'->>'good_referral'='검토 비공개 리퍼럴' and value->>'raw_text' like '관리자 전용%' from interview_test_state where key='interview'),'partial draft updates retain all absent proposal and original fields');
select pg_temp.check_true((select public.save_member_interview_draft((value->>'id')::uuid,3,'{"public_patch":{"wants":"추가 검토 비지터"}}')->>'revision'='3' from interview_test_state where key='interview'),'identical draft does not generate extra revision/history');
select pg_temp.check_denied($q$select public.save_member_interview_draft((value->>'id')::uuid,2,'{}') from interview_test_state where key='interview'$q$,'stale draft revision rejected','40001');
select pg_temp.check_denied($q$select public.save_member_interview_draft((value->>'id')::uuid,3,jsonb_build_object('raw_text',repeat('x',120001))) from interview_test_state where key='interview'$q$,'extracted source text cap enforced','22023');
select pg_temp.check_denied($q$select public.save_member_interview_draft((value->>'id')::uuid,3,'{"public_patch":{"good_referral":"leak"}}') from interview_test_state where key='interview'$q$,'review public proposal rejects sensitive keys','22023');
update interview_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,3,'{"status":"reviewed"}') where key='interview';
select pg_temp.check_denied($q$select public.apply_member_interview((value->>'id')::uuid,4,now()-interval '1 day','{"company":"stale"}','{}') from interview_test_state where key='interview'$q$,'stale public snapshot blocks whole apply','40001');
select pg_temp.check_denied($q$select public.apply_member_interview((value->>'id')::uuid,4,now(),'{}','{}') from interview_test_state where key='interview'$q$,'empty selection cannot mark applied','22023');
reset role;
alter table private.member_details add constraint interview_test_atomic_failure check (good_referral<>'__rollback__');
set local role authenticated;
select pg_temp.check_denied($q$select public.apply_member_interview((s.value->>'id')::uuid,4,m.updated_at,'{"company":"MUST ROLLBACK"}','{"good_referral":"__rollback__"}') from interview_test_state s,public.members m where s.key='interview' and m.id='44444444-4444-4444-8444-444444444401'$q$,'private failure rolls back public change and review state','23514');
select pg_temp.check_true((select company='기존 회사' from public.members where id='44444444-4444-4444-8444-444444444401'),'public value retained after failed atomic apply');
select pg_temp.check_true((select public.get_member_interview((value->>'id')::uuid)->>'revision'='4' from interview_test_state where key='interview'),'review revision retained after failed atomic apply');
insert into interview_test_state select 'applied',public.apply_member_interview((s.value->>'id')::uuid,4,m.updated_at,
  '{"company":"반영 회사","customers":["공개 고객 유형 개선"],"is_real":true}',
  '{"good_referral":"반영 비공개 리퍼럴","triggers":["반영 비공개 트리거"],"customer_companies":["실제 고객사 B"]}')
  from interview_test_state s,public.members m where s.key='interview' and m.id='44444444-4444-4444-8444-444444444401';
select pg_temp.check_true((select value->>'status'='applied' and value->>'revision'='5' and value->>'details_revision'='3' from interview_test_state where key='applied'),'successful apply returns both resulting versions');
select pg_temp.check_true((select company='반영 회사' and customers=array['공개 고객 유형 개선'] and synergies=array['기존 상생직군'] and wants='기존 비지터'
  and is_real and good_referral='' and triggers='{}'::text[] from public.members where id='44444444-4444-4444-8444-444444444401'),'atomic apply changes selected public fields only and leaves private legacy columns empty');
select pg_temp.check_true(public.get_member_details('44444444-4444-4444-8444-444444444401')->0->'customer_companies'='["실제 고객사 B"]'::jsonb,'actual company names stored only in private details');
select pg_temp.check_true((select jsonb_array_length(public.get_member_interview((value->>'id')::uuid)->'history')=5 from interview_test_state where key='interview'),'creation, changes, review, and applied snapshots retained once');
select pg_temp.check_denied($q$select public.save_member_interview_draft((value->>'id')::uuid,5,'{"raw_text":"overwrite applied source"}') from interview_test_state where key='interview'$q$,'applied document is immutable','22023');
select pg_temp.check_denied($q$update public.members set good_referral='admin leak' where id='44444444-4444-4444-8444-444444444401'$q$,'admin legacy write cannot accidentally publish private field');
select pg_temp.check_denied($q$insert into public.members(name,good_referral) values ('legacy import','leak')$q$,'legacy import cannot republish private fields');
select pg_temp.check_denied($q$delete from public.members where id='44444444-4444-4444-8444-444444444401'$q$,'original document retention has specific deletion guard','P0001');

-- Analysis leases do not apply anything. Only their successful completion adds
-- one history entry. Wrong tokens, parallel calls and expired results fail closed.
insert into interview_test_state values ('analysis',public.create_member_interview('44444444-4444-4444-8444-444444444401','44444444-4444-4444-8444-444444444401/analysis.txt','analysis.txt'));
insert into interview_test_state select 'lease',public.begin_member_interview_analysis((value->>'id')::uuid,1) from interview_test_state where key='analysis';
select pg_temp.check_true((select value?'lease_id' and value?'expires_at' and value->'interview'->>'revision'='1' from interview_test_state where key='lease'),'admin acquires analysis lease');
select pg_temp.check_denied($q$select public.begin_member_interview_analysis((value->>'id')::uuid,1) from interview_test_state where key='analysis'$q$,'parallel analysis rejected','55000');
select pg_temp.check_denied($q$select public.save_member_interview_draft((value->>'id')::uuid,1,'{"raw_text":"racing edit"}') from interview_test_state where key='analysis'$q$,'editing cannot race active analysis','55000');
select pg_temp.check_denied($q$select public.finish_member_interview_analysis((value->>'id')::uuid,'55555555-5555-4555-8555-555555555501',1,'{"extracted":{"no":true}}') from interview_test_state where key='analysis'$q$,'wrong analysis lease cannot save','40001');
select pg_temp.check_true((select public.cancel_member_interview_analysis((value->>'id')::uuid,'55555555-5555-4555-8555-555555555501')->>'released'='false' from interview_test_state where key='analysis'),'wrong lease cannot cancel another analysis');
update interview_test_state s set value=public.finish_member_interview_analysis((s.value->>'id')::uuid,(l.value->>'lease_id')::uuid,1,'{"extracted":{"synthetic":true}}')
  from interview_test_state l where s.key='analysis' and l.key='lease';
select pg_temp.check_true((select value->>'revision'='2' and value->'extracted'->>'synthetic'='true' and value->>'status'='draft' from interview_test_state where key='analysis'),'analysis completion saves proposal only');
select pg_temp.check_denied($q$select public.begin_member_interview_analysis((value->>'id')::uuid,2) from interview_test_state where key='analysis'$q$,'immediate paid-analysis retry is cooled down','55000');
reset role;
update private.member_interviews set analysis_started_at=clock_timestamp()-interval '1 minute'
  where id=(select (value->>'id')::uuid from interview_test_state where key='analysis');
set local role authenticated;
update interview_test_state set value=public.begin_member_interview_analysis((select (value->>'id')::uuid from interview_test_state where key='analysis'),2) where key='lease';
reset role;
update private.member_interviews set analysis_expires_at=clock_timestamp()-interval '1 second'
  where id=(select (value->>'id')::uuid from interview_test_state where key='analysis');
set local role authenticated;
select pg_temp.check_denied($q$select public.finish_member_interview_analysis((a.value->>'id')::uuid,(l.value->>'lease_id')::uuid,2,'{"extracted":{"expired":true}}') from interview_test_state a,interview_test_state l where a.key='analysis' and l.key='lease'$q$,'expired AI result cannot overwrite a draft','40001');
select pg_temp.check_true((select public.cancel_member_interview_analysis((a.value->>'id')::uuid,(l.value->>'lease_id')::uuid)->>'released'='true' from interview_test_state a,interview_test_state l where a.key='analysis' and l.key='lease'),'owner of expired analysis token can release it');

select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333302","role":"authenticated"}',true);
select pg_temp.check_denied($q$select public.get_member_interview((value->>'id')::uuid) from interview_test_state where key='interview'$q$,'linked member still cannot read original/history after apply');
select pg_temp.check_denied($q$select public.begin_member_interview_analysis((value->>'id')::uuid,2) from interview_test_state where key='analysis'$q$,'member cannot trigger external analysis lease');
select pg_temp.check_true(public.get_member_details()->0->>'good_referral'='반영 비공개 리퍼럴','linked member can read applied private fields');
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333301","role":"authenticated"}',true);
select public.admin_set_member_access('33333333-3333-4333-8333-333333333302','viewer');
select set_config('request.jwt.claims','{"sub":"33333333-3333-4333-8333-333333333302","role":"authenticated"}',true);
select pg_temp.check_denied('select public.get_member_details()','revoked member cannot reuse same JWT to read private data');

reset role;
select pg_temp.check_true((select updated_by='33333333-3333-4333-8333-333333333301'::uuid from private.member_details where member_id='44444444-4444-4444-8444-444444444401'),'private audit actor derived from authenticated user');
select pg_temp.check_true(not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='private'
  and tablename in ('member_details','member_interviews','member_interview_history')),'private data is not published through public realtime');
select pg_temp.check_true((select not public and file_size_limit=20971520 and array_length(allowed_mime_types,1)=3 from storage.buckets where id='member-interviews'),'private bucket restricts size and three supported MIME types');
select pg_temp.check_true(not exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in ('get_member_details','update_member_details','create_member_interview','list_member_interviews','get_member_interview',
    'save_member_interview_draft','apply_member_interview','begin_member_interview_analysis','finish_member_interview_analysis','cancel_member_interview_analysis') and p.prosecdef),'public RPC wrappers are security invoker');
rollback;
