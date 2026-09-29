-- Isolated regression tests; all fixtures roll back.
begin;
set local statement_timeout='30s';
create function pg_temp.referral_check(ok boolean,label text)
returns void language plpgsql security invoker as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
create function pg_temp.referral_denied(statement text,label text)
returns void language plpgsql security invoker as $$ begin
  begin execute statement; exception when others then
    if sqlstate='42501' then raise notice 'PASS: %',label; return; end if;
    raise exception 'FAIL: %, unexpected %: %',label,sqlstate,sqlerrm;
  end;
  raise exception 'FAIL: %, statement was allowed',label;
end $$;
create temporary table referral_test_state(key text primary key,value jsonb);
grant select,insert,update on referral_test_state to authenticated;
do $$ begin execute format('grant usage on schema %I to anon,authenticated,service_role',pg_my_temp_schema()::regnamespace); end $$;
insert into auth.users(id,email,email_confirmed_at,is_anonymous,raw_user_meta_data) values
('77777777-7777-4777-8777-777777777701','referral-admin@example.invalid',now(),false,'{}'),
('77777777-7777-4777-8777-777777777702','referral-member@example.invalid',now(),false,'{}'),
('77777777-7777-4777-8777-777777777703','referral-other@example.invalid',now(),false,'{}'),
('77777777-7777-4777-8777-777777777704','referral-viewer@example.invalid',now(),false,'{"role":"admin","member_id":"88888888-8888-4888-8888-888888888801"}'),
('77777777-7777-4777-8777-777777777705','referral-pending@example.invalid',now(),false,'{}');
insert into public.members(id,name,sort_order,field,synergies) values
('88888888-8888-4888-8888-888888888801','소개 멤버 A',1,'회계사',array['앱 개발']),
('88888888-8888-4888-8888-888888888802','소개 멤버 B',2,'앱 개발',array['회계사']),
('88888888-8888-4888-8888-888888888803','빈 소개 멤버',3,'인쇄','{}');
update public.member_accounts set role='admin' where user_id='77777777-7777-4777-8777-777777777701';
update public.member_accounts set role='member',member_id='88888888-8888-4888-8888-888888888801',request_status='approved' where user_id='77777777-7777-4777-8777-777777777702';
update public.member_accounts set role='member',member_id='88888888-8888-4888-8888-888888888802',request_status='approved' where user_id='77777777-7777-4777-8777-777777777703';
update public.member_accounts set requested_member_id='88888888-8888-4888-8888-888888888803',request_status='pending' where user_id='77777777-7777-4777-8777-777777777705';
insert into private.member_details(member_id,good_referral,triggers,customer_companies) values
('88888888-8888-4888-8888-888888888801','세무 상담이 필요한 대표',array['장부 정리가 어렵다'],array['A 실제 고객사']),
('88888888-8888-4888-8888-888888888802','업무 앱이 필요한 대표',array['반복 업무를 자동화하고 싶다'],array['B 실제 고객사']);
insert into storage.objects(bucket_id,name,metadata) values
('member-interviews','88888888-8888-4888-8888-888888888802/profile.txt','{"size":100,"mimetype":"text/plain"}'),
('member-interviews','88888888-8888-4888-8888-888888888802/credibility.txt','{"size":100,"mimetype":"text/plain"}');

set local role anon;
select pg_temp.referral_denied('select public.get_member_referrals()','anonymous cannot call shared referrals');
select pg_temp.referral_denied('select private.get_member_referrals()','anonymous cannot bypass the public wrapper');
set local role authenticated;
select set_config('request.jwt.claims','{}',true);
select pg_temp.referral_denied('select public.get_member_referrals()','authenticated without a user cannot read referrals');
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777704","role":"authenticated","user_metadata":{"role":"admin","member_id":"88888888-8888-4888-8888-888888888801"}}',true);
select pg_temp.referral_denied('select public.get_member_referrals()','viewer cannot use editable metadata to read referrals');
select pg_temp.referral_denied('select private.get_member_referrals()','viewer cannot bypass wrapper authorization');
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777705","role":"authenticated"}',true);
select pg_temp.referral_denied('select public.get_member_referrals()','pending member claim does not grant chapter access');
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777799","role":"authenticated","app_metadata":{"role":"admin"}}',true);
select pg_temp.referral_denied('select public.get_member_referrals()','unknown or deleted user with stale role claims cannot read referrals');

select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777702","role":"authenticated"}',true);
select pg_temp.referral_check(jsonb_array_length(public.get_member_referrals())=3,'approved member can read every chapter member');
select pg_temp.referral_check(public.get_member_referrals('88888888-8888-4888-8888-888888888802')->0->>'good_referral'='업무 앱이 필요한 대표'
  and public.get_member_referrals('88888888-8888-4888-8888-888888888802')->0->'triggers'='["반복 업무를 자동화하고 싶다"]'::jsonb,'other member referral guidance is visible');
select pg_temp.referral_check((select bool_and((select array_agg(key order by key) from jsonb_object_keys(item) key)=array['good_referral','member_id','triggers']) from jsonb_array_elements(public.get_member_referrals()) item),'shared RPC exposes exactly member_id, good_referral and triggers');
select pg_temp.referral_check(public.get_member_referrals('88888888-8888-4888-8888-888888888803')='[{"member_id":"88888888-8888-4888-8888-888888888803","good_referral":"","triggers":[]}]'::jsonb,'missing detail row has empty referral defaults');
select pg_temp.referral_check(public.get_member_referrals('88888888-8888-4888-8888-888888888899')='[]'::jsonb,'nonexistent member returns an empty list');
select pg_temp.referral_denied('select * from private.member_details','member still cannot read private table directly');
select pg_temp.referral_denied($q$select public.get_member_details('88888888-8888-4888-8888-888888888802')$q$,'other member customer names remain private');
select pg_temp.referral_check(public.get_member_details()->0->'customer_companies'='["A 실제 고객사"]'::jsonb,'member retains access to own actual customer names');
select pg_temp.referral_denied($q$select public.update_member_details('88888888-8888-4888-8888-888888888802',1,'{"good_referral":"unauthorized"}')$q$,'shared read does not grant another member edit access');
select pg_temp.referral_denied($q$update private.member_details set good_referral='unauthorized'$q$,'shared read does not grant direct private writes');
select pg_temp.referral_check(public.update_member_details('88888888-8888-4888-8888-888888888801',1,'{"good_referral":"본인 소개 수정"}')->>'good_referral'='본인 소개 수정','member retains own referral edit permission');
select pg_temp.referral_denied($q$select public.list_member_interviews('88888888-8888-4888-8888-888888888802')$q$,'shared read does not expose source document list');
select pg_temp.referral_denied($q$select public.list_member_interview_reviews('88888888-8888-4888-8888-888888888802')$q$,'shared read does not expose AI review drafts');
select pg_temp.referral_denied('select * from private.member_interviews','source originals retain table protection');
select pg_temp.referral_denied('select * from private.member_interview_reviews','AI proposals retain table protection');
select pg_temp.referral_check((select field='앱 개발' and synergies=array['회계사'] and good_referral='' and triggers='{}'::text[] from public.members where id='88888888-8888-4888-8888-888888888802'),'public matching fields remain available without copying referral data to public rows');

reset role;
update auth.users set email_confirmed_at=null where id='77777777-7777-4777-8777-777777777702';
set local role authenticated;
select pg_temp.referral_denied('select public.get_member_referrals()','unconfirmed linked member cannot read referrals');
reset role;
update auth.users set email_confirmed_at=now(),is_anonymous=true where id='77777777-7777-4777-8777-777777777702';
set local role authenticated;
select pg_temp.referral_denied('select public.get_member_referrals()','anonymous Auth sign-in cannot inherit member access');
reset role;
update auth.users set is_anonymous=false,email='' where id='77777777-7777-4777-8777-777777777702';
set local role authenticated;
select pg_temp.referral_denied('select public.get_member_referrals()','member with empty email is denied');
reset role;
update auth.users set email='referral-member@example.invalid' where id='77777777-7777-4777-8777-777777777702';
update public.member_accounts set role='viewer',member_id=null where user_id='77777777-7777-4777-8777-777777777702';
set local role authenticated;
select pg_temp.referral_denied('select public.get_member_referrals()','revoked member cannot reuse the same JWT to read referrals');
reset role;
update public.member_accounts set role='member',member_id='88888888-8888-4888-8888-888888888801' where user_id='77777777-7777-4777-8777-777777777702';

-- Actual integrated review application must immediately update shared guidance.
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777701","role":"authenticated"}',true);
select pg_temp.referral_check(jsonb_array_length(public.get_member_referrals())=3,'confirmed admin can read all member referrals');
insert into referral_test_state values
('d1',public.create_member_interview('88888888-8888-4888-8888-888888888802','88888888-8888-4888-8888-888888888802/profile.txt','신상명세표.txt')),
('d2',public.create_member_interview('88888888-8888-4888-8888-888888888802','88888888-8888-4888-8888-888888888802/credibility.txt','신뢰 단계.txt'));
update referral_test_state set value=public.save_member_interview_draft((value->>'id')::uuid,1,'{"raw_text":"원본의 비공개 정보와 실제 고객사 이름"}') where key in ('d1','d2');
insert into referral_test_state select 'start',public.begin_member_interview_review_analysis(array_agg((value->>'id')::uuid order by key)) from referral_test_state where key in ('d1','d2');
insert into referral_test_state select 'review',public.finish_member_interview_review_analysis((s.value->'review'->>'id')::uuid,1,(s.value->>'lease_id')::uuid,
  jsonb_build_object('suggestions',jsonb_build_array(
    jsonb_build_object('key','good_referral','value',jsonb_build_array('통합 분석에서 승인된 소개 조건'),'sources',jsonb_build_array(d1.value->>'id')),
    jsonb_build_object('key','triggers','value',jsonb_build_array('새 앱이 필요하다'),'sources',jsonb_build_array(d2.value->>'id')))))
  from referral_test_state s,referral_test_state d1,referral_test_state d2 where s.key='start' and d1.key='d1' and d2.key='d2';
select pg_temp.referral_check(public.get_member_referrals('88888888-8888-4888-8888-888888888802')->0->>'good_referral'='업무 앱이 필요한 대표','AI suggestions remain unpublished until applied');
update referral_test_state s set value=public.apply_member_interview_review((s.value->>'id')::uuid,2,m.updated_at,'{}','{"good_referral":"통합 분석에서 승인된 소개 조건","triggers":["새 앱이 필요하다"],"customer_companies":["통합 실제 고객사"]}')
  from public.members m where s.key='review' and m.id='88888888-8888-4888-8888-888888888802';
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777702","role":"authenticated"}',true);
select pg_temp.referral_check(public.get_member_referrals('88888888-8888-4888-8888-888888888802')->0->>'good_referral'='통합 분석에서 승인된 소개 조건'
  and public.get_member_referrals('88888888-8888-4888-8888-888888888802')->0->'triggers'='["반복 업무를 자동화하고 싶다","새 앱이 필요하다"]'::jsonb,'another member immediately sees applied integrated referral guidance and appended triggers');
select pg_temp.referral_check(public.get_member_referrals()::text not like '%실제 고객사%' and public.get_member_referrals()::text not like '%원본의 비공개%','shared response excludes actual customer names and original document text');
select pg_temp.referral_denied($q$select public.get_member_interview((value->>'id')::uuid) from referral_test_state where key='d1'$q$,'another member cannot retrieve known source document ID');
select pg_temp.referral_denied($q$select public.get_member_interview_review((value->>'id')::uuid) from referral_test_state where key='review'$q$,'another member cannot retrieve known review ID');
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777703","role":"authenticated"}',true);
select pg_temp.referral_check(public.get_member_referrals('88888888-8888-4888-8888-888888888801')->0->>'good_referral'='본인 소개 수정','sharing works in both directions including manual edits');

reset role;
update auth.users set email_confirmed_at=null where id='77777777-7777-4777-8777-777777777701';
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"77777777-7777-4777-8777-777777777701","role":"authenticated"}',true);
select pg_temp.referral_denied('select public.get_member_referrals()','unconfirmed admin cannot read shared referrals');
reset role;
select pg_temp.referral_check((select not p.prosecdef and p.proconfig=array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='get_member_referrals'),'public RPC is security invoker with empty search path');
select pg_temp.referral_check((select p.prosecdef and p.proconfig=array['search_path=""'] from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='private' and p.proname='get_member_referrals'),'privileged reader stays in private schema with empty search path');
select pg_temp.referral_check(not has_function_privilege('anon','public.get_member_referrals(uuid)','execute') and has_function_privilege('authenticated','public.get_member_referrals(uuid)','execute'),'only authenticated role receives public RPC execution');
select pg_temp.referral_check(not has_table_privilege('authenticated','private.member_details','select') and not has_table_privilege('authenticated','private.member_details','update'),'sharing does not add private table grants');
rollback;
