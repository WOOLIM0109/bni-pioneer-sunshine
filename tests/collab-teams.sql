-- Local PGlite/isolated database only. All role and editor fixtures roll back.
begin;
create function pg_temp.collab_check(ok boolean,label text) returns void language plpgsql as $$ begin
  if ok is distinct from true then raise exception 'FAIL: %',label; end if;
  raise notice 'PASS: %',label;
end $$;
create function pg_temp.collab_denied(statement text,label text,expected text default '42501') returns void language plpgsql security invoker as $$ begin
  begin execute statement; exception when others then
    if sqlstate=expected then raise notice 'PASS: %',label; return; end if;
    raise exception 'FAIL: %, got %: %',label,sqlstate,sqlerrm;
  end;
  raise exception 'FAIL: %, statement succeeded',label;
end $$;
do $$ begin execute format('grant usage on schema %I to anon,authenticated',pg_my_temp_schema()::regnamespace); end $$;
create temporary table collab_test_state(key text primary key,value jsonb);
grant select,insert,update on collab_test_state to authenticated;
insert into collab_test_state values('leader1',to_jsonb((select id from public.members where name='마루이'))),('leader2',to_jsonb((select id from public.members where name='박선영')));
insert into auth.users(id,email,email_confirmed_at,is_anonymous) values
('99999999-0000-4000-8000-000000000001','collab-admin@example.invalid',now(),false),
('99999999-0000-4000-8000-000000000002','collab-member@example.invalid',now(),false),
('99999999-0000-4000-8000-000000000003','collab-other@example.invalid',now(),false),
('99999999-0000-4000-8000-000000000004','collab-viewer@example.invalid',now(),false);
update public.member_accounts set role='admin' where user_id='99999999-0000-4000-8000-000000000001';
update public.member_accounts set role='member',member_id=(select id from public.members where name='마루이') where user_id='99999999-0000-4000-8000-000000000002';
update public.member_accounts set role='member',member_id=(select id from public.members where name='박선영') where user_id='99999999-0000-4000-8000-000000000003';
-- Existing saved proposals may still contain team. Preserve their evidence,
-- and verify the remaining selected fields can be applied without that key.
insert into private.member_interviews(id,member_id,storage_path,original_name,mime_type,file_size,raw_text,extracted,public_patch)
select '99999999-0000-4000-8000-000000000091',id,'collab-test/legacy.txt','신상명세표.txt','text/plain',100,'보관 원문',
  '{"suggestions":[{"key":"team","value":["old team"]},{"key":"field","value":["preserved field"]}]}','{"team":"old team","field":"preserved field"}'
from public.members where name='마루이';
insert into private.member_interview_reviews(id,member_id,source_interview_ids,source_revisions,source_documents,extracted,public_patch,status)
select '99999999-0000-4000-8000-000000000092',id,array['99999999-0000-4000-8000-000000000091'::uuid],'{"99999999-0000-4000-8000-000000000091":1}','[]',
  '{"suggestions":[{"key":"team","value":["old team"],"sources":["99999999-0000-4000-8000-000000000091"]},{"key":"field","value":["new field"],"sources":["99999999-0000-4000-8000-000000000091"]}]}','{"team":"old team","field":"new field"}','draft'
from public.members where name='마루이';
select pg_temp.collab_check((select array_agg(n order by sort_order) from (select t.sort_order,count(m.member_id)::int n from public.collab_teams t left join public.collab_team_members m on m.team_id=t.id group by t.id) x)=array[4,10,9,5,5],'initial five team counts are 4/10/9/5/5');
select pg_temp.collab_check((select count(distinct member_id)=33 from public.collab_team_members) and not exists(select 1 from public.members m where not exists(select 1 from public.collab_team_members tm where tm.member_id=m.id)),'all 33 registered members are assigned without missing UUIDs');
select pg_temp.collab_check(exists(select 1 from public.members m join public.collab_team_members tm on tm.member_id=m.id join public.collab_teams t on t.id=tm.team_id where m.name='이소연' and t.name='웰니스 협업팀') and not exists(select 1 from public.members where name='이서원'),'wellness includes 이소연 and no 이서원 is created');
select pg_temp.collab_check(not exists(select 1 from public.collab_teams t where t.leader_member_id is not null and not exists(select 1 from public.collab_team_members m where m.team_id=t.id and m.member_id=t.leader_member_id)),'every leader belongs to the same team');
select pg_temp.collab_denied($q$select private.validate_member_patch('{"team":"obsolete"}','public')$q$,'retired team patch is rejected by shared DB validator','22023');
select pg_temp.collab_denied($q$select private.validate_interview_review_analysis('{"suggestions":[{"key":"team","value":["obsolete"],"sources":["99999999-0000-4000-8000-000000000001"]}]}',array['99999999-0000-4000-8000-000000000001'::uuid])$q$,'new AI team proposal is rejected','22023');

set local role anon;
select pg_temp.collab_check((select count(id)=5 from public.collab_teams),'anonymous can read public team columns');
select pg_temp.collab_check((select count(*)=33 from public.collab_team_members),'anonymous can read team memberships');
select pg_temp.collab_denied('select chat_link from public.collab_teams','anonymous cannot select chat_link');
select pg_temp.collab_denied('select * from public.collab_teams','select star cannot leak chat links');
select pg_temp.collab_denied('select public.get_collab_team_chat_links()','anonymous cannot invoke private link reader');
select pg_temp.collab_denied('select public.get_collab_team_admin()','anonymous cannot read admin roster');
set local role authenticated;
select set_config('request.jwt.claims','{"sub":"99999999-0000-4000-8000-000000000001"}',true);
insert into collab_test_state values('admin',public.get_collab_team_admin());
update collab_test_state set value=public.save_collab_teams((value->>'revision')::bigint,
  (select jsonb_agg(t||jsonb_build_object('chat_link','https://example.invalid/team/'||(t->>'id'))) from jsonb_array_elements(value->'teams') t),value->'memberships',value->'pending_names') where key='admin';
select pg_temp.collab_check(jsonb_array_length(public.get_collab_team_chat_links())=5,'administrator sees every configured chat link');
select pg_temp.collab_check(public.get_member_interview_review('99999999-0000-4000-8000-000000000092')->'extracted'->'suggestions'->0->>'key'='team','historical team proposal remains readable without data rewriting');
select pg_temp.collab_denied($q$select public.apply_member_interview_review('99999999-0000-4000-8000-000000000092',1,updated_at,'{"team":"old team","field":"new field"}','{}') from public.members where name='마루이'$q$,'old reviewed team payload cannot write retired team','22023');
select pg_temp.collab_check(public.apply_member_interview_review('99999999-0000-4000-8000-000000000092',1,(select updated_at from public.members where name='마루이'),'{"field":"new field"}','{}')->>'status'='applied'
  and (select team='미정' from public.members where name='마루이'),'other selected proposal from legacy integrated review still applies');
select pg_temp.collab_check(public.apply_member_interview('99999999-0000-4000-8000-000000000091',1,(select updated_at from public.members where name='마루이'),'{"field":"preserved field"}','{}')->>'status'='applied'
  and (select team='미정' from public.members where name='마루이'),'other selected field from legacy document review still applies');
select pg_temp.collab_denied('select chat_link from public.collab_teams','even admin must use scoped RPC for chat data');
select pg_temp.collab_denied($q$update public.members set team='old importer writes company here' where name='마루이'$q$,'old authenticated team update is blocked during deployment');
select pg_temp.collab_denied($q$insert into public.members(name,team) values('old bulk','company column')$q$,'old four-column bulk insert is blocked');
select pg_temp.collab_denied($q$select public.save_collab_teams(0,value->'teams',value->'memberships',value->'pending_names') from collab_test_state where key='admin'$q$,'stale matrix revision is rejected','40001');
select pg_temp.collab_denied($q$select public.save_collab_teams((value->>'revision')::bigint,
  (select jsonb_agg(case when t->>'id'='90000000-0000-4000-8000-000000000001' then t||jsonb_build_object('leader_member_id',(select value from collab_test_state where key='leader2')) else t end) from jsonb_array_elements(value->'teams') t),value->'memberships','[]') from collab_test_state where key='admin'$q$,'nonmember cannot be assigned as team leader','22023');
select pg_temp.collab_denied($q$select public.save_collab_teams((value->>'revision')::bigint,
  (select jsonb_agg(t||'{"chat_link":"javascript:alert(1)"}') from jsonb_array_elements(value->'teams') t),value->'memberships','[]') from collab_test_state where key='admin'$q$,'unsafe chat URL is rejected','23514');

select set_config('request.jwt.claims','{"sub":"99999999-0000-4000-8000-000000000002"}',true);
select pg_temp.collab_check(jsonb_array_length(public.get_collab_team_chat_links())=1 and public.get_collab_team_chat_links()->0->>'team_id'='90000000-0000-4000-8000-000000000001','member sees only own team chat');
select pg_temp.collab_denied('select public.get_collab_team_admin()','regular member cannot read admin draft');
select pg_temp.collab_denied($q$select public.save_collab_teams(1,'[]','[]','[]')$q$,'member cannot edit team matrix');
select pg_temp.collab_denied('delete from public.collab_team_members','member cannot directly remove memberships');
select pg_temp.collab_denied($q$update public.members set chapter_role='의장' where name='마루이'$q$,'member cannot promote own chapter role');
select set_config('request.jwt.claims','{"sub":"99999999-0000-4000-8000-000000000004","user_metadata":{"role":"admin"}}',true);
select pg_temp.collab_check(public.get_collab_team_chat_links()='[]'::jsonb,'viewer and editable role claims grant no chat access');

select set_config('request.jwt.claims','{"sub":"99999999-0000-4000-8000-000000000001"}',true);
update collab_test_state set value=public.save_collab_teams((value->>'revision')::bigint,value->'teams',value->'memberships'||jsonb_build_array(jsonb_build_object('team_id','90000000-0000-4000-8000-000000000002','member_id',(select value from collab_test_state where key='leader1'))),
  '[{"team_id":"90000000-0000-4000-8000-000000000001","name":"미등록 테스트"},{"team_id":"90000000-0000-4000-8000-000000000001","name":"마루이"}]') where key='admin';
select pg_temp.collab_check((select count(*)=2 from public.collab_team_members where member_id=(select (value#>>'{}')::uuid from collab_test_state where key='leader1')),'one member may belong to multiple teams');
select pg_temp.collab_check(public.get_collab_team_admin()->'pending_names'='[{"team_id":"90000000-0000-4000-8000-000000000001","name":"미등록 테스트"}]'::jsonb and not exists(select 1 from public.members where name='미등록 테스트'),'unmatched name persists and resolved assigned name clears without creating a member');
update collab_test_state set value=public.save_collab_teams((value->>'revision')::bigint,
  value->'teams'||jsonb_build_array(jsonb_build_object('id','90000000-0000-4000-8000-000000000099','name','테스트 협업팀','sort_order',0,'leader_member_id',(select value from collab_test_state where key='leader1'),'note','new team note','chat_link','')),
  value->'memberships'||jsonb_build_array(jsonb_build_object('team_id','90000000-0000-4000-8000-000000000099','member_id',(select value from collab_test_state where key='leader1'))),value->'pending_names') where key='admin';
select pg_temp.collab_check(exists(select 1 from public.collab_teams where id='90000000-0000-4000-8000-000000000099' and sort_order=0 and note='new team note'),'admin can add a team, order, note and a valid leader atomically');
update collab_test_state set value=public.save_collab_teams((value->>'revision')::bigint,
  (select jsonb_agg(case when t->>'id'='90000000-0000-4000-8000-000000000099' then t||'{"name":"이름 수정 팀","sort_order":6}' else t end) from jsonb_array_elements(value->'teams') t),value->'memberships',value->'pending_names') where key='admin';
select pg_temp.collab_check(exists(select 1 from public.collab_teams where id='90000000-0000-4000-8000-000000000099' and name='이름 수정 팀' and sort_order=6),'admin can rename and reorder an existing team');
update collab_test_state set value=public.save_collab_teams((value->>'revision')::bigint,
  (select jsonb_agg(t) from jsonb_array_elements(value->'teams') t where t->>'id'<>'90000000-0000-4000-8000-000000000099'),
  (select jsonb_agg(m) from jsonb_array_elements(value->'memberships') m where m->>'team_id'<>'90000000-0000-4000-8000-000000000099'),value->'pending_names') where key='admin';
select pg_temp.collab_check(not exists(select 1 from public.collab_teams where id='90000000-0000-4000-8000-000000000099') and not exists(select 1 from public.collab_team_members where team_id='90000000-0000-4000-8000-000000000099'),'admin delete removes a team and memberships together');
select set_config('request.jwt.claims','{"sub":"99999999-0000-4000-8000-000000000002"}',true);
select pg_temp.collab_check(jsonb_array_length(public.get_collab_team_chat_links())=2,'multi-team member sees both own chat links');
reset role;
update auth.users set email_confirmed_at=null where id='99999999-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.collab_check(public.get_collab_team_chat_links()='[]'::jsonb,'unconfirmed member cannot read chat');
reset role;
update auth.users set email_confirmed_at=now(),is_anonymous=true where id='99999999-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.collab_check(public.get_collab_team_chat_links()='[]'::jsonb,'anonymous auth sign-in cannot inherit chat access');
reset role;
update auth.users set is_anonymous=false where id='99999999-0000-4000-8000-000000000002';
update public.member_accounts set role='viewer',member_id=null where user_id='99999999-0000-4000-8000-000000000002';
set local role authenticated;
select pg_temp.collab_check(public.get_collab_team_chat_links()='[]'::jsonb,'revoked member cannot use stale token for chat');
reset role;
select pg_temp.collab_check(not exists(select 1 from pg_publication_tables where schemaname='public' and tablename='collab_teams'),'chat-containing table is not published to Realtime');
rollback;
