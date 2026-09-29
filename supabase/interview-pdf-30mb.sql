-- 운영 수동 적용용. 이 파일 전체를 한 번 실행합니다. 자동 배포에서는 실행하지 않습니다.
-- 변경: 기존 버킷 / CHECK / 문서 등록 함수의 20971520 -> 31457280 및 오류문구 20MB -> 30MB.
-- 새 컬럼·테이블·함수·권한을 추가하지 않으며 문서 데이터·협업팀·통합 분석은 변경하지 않습니다.
-- 적용 후 맨 아래 SELECT에서 bucket_bytes=31457280, 모든 *_ok=true인지 확인합니다.
begin;
set local lock_timeout = '5s';

do $pdf_limit$
declare
  bucket_limit bigint;
  constraint_text text;
  constraint_valid boolean;
  function_id regprocedure := to_regprocedure('private.create_member_interview(uuid,text,text)');
  function_body text;
  function_definition text;
  replacement_definition text;
  old_message constant text := '20MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.';
  new_message constant text := '30MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.';
begin
  lock table private.member_interviews in access exclusive mode;
  select file_size_limit into bucket_limit from storage.buckets where id='member-interviews' for update;
  if not found or bucket_limit is null or bucket_limit not in (20971520,31457280) then
    raise exception 'member-interviews 버킷의 기존 20MB/30MB 설정을 확인하세요. 변경하지 않았습니다.';
  end if;
  select pg_get_constraintdef(oid),convalidated into constraint_text,constraint_valid
    from pg_constraint where conrelid='private.member_interviews'::regclass
      and conname='member_interviews_file_size_check' and contype='c';
  if not found or not constraint_valid or constraint_text not in (
    'CHECK (((file_size > 0) AND (file_size <= 20971520)))',
    'CHECK (((file_size > 0) AND (file_size <= 31457280)))'
  ) then
    raise exception '문서 file_size CHECK가 예상 정의와 다릅니다. 변경하지 않았습니다.';
  end if;
  if function_id is null then raise exception '기존 문서 등록 함수를 찾지 못했습니다. 변경하지 않았습니다.'; end if;
  select prosrc,pg_get_functiondef(oid) into function_body,function_definition from pg_proc where oid=function_id;
  if position('size_value>20971520' in function_body)>0
    and length(function_body)-length(replace(function_body,'20971520',''))=8
    and position('31457280' in function_body)=0
    and length(function_body)-length(replace(function_body,old_message,''))=length(old_message)
    and position(new_message in function_body)=0 then
    replacement_definition:=replace(replace(function_definition,'size_value>20971520','size_value>31457280'),old_message,new_message);
    if replace(replace(replacement_definition,'size_value>31457280','size_value>20971520'),new_message,old_message)<>function_definition then
      raise exception '함수 변경이 용량 숫자·안내문구에 한정되지 않습니다. 변경하지 않았습니다.';
    end if;
  elsif position('size_value>31457280' in function_body)>0
    and length(function_body)-length(replace(function_body,'31457280',''))=8
    and position('20971520' in function_body)=0
    and length(function_body)-length(replace(function_body,new_message,''))=length(new_message)
    and position(old_message in function_body)=0 then
    replacement_definition:=null; -- 이미 적용됨. 반복 실행해도 기존 정의를 그대로 둡니다.
  else
    raise exception '문서 등록 함수의 기존 한도·문구를 확인하세요. 변경하지 않았습니다.';
  end if;

  if position('20971520' in constraint_text)>0 then
    alter table private.member_interviews drop constraint member_interviews_file_size_check;
    execute 'alter table private.member_interviews add constraint member_interviews_file_size_check '
      ||replace(constraint_text,'20971520','31457280');
  end if;
  if replacement_definition is not null then execute replacement_definition; end if;
  update storage.buckets set file_size_limit=31457280 where id='member-interviews' and file_size_limit<>31457280;
end $pdf_limit$;
commit;

-- 실행 후 확인 쿼리: 이 SELECT만 다시 실행해도 됩니다.
-- 기대: 1행, bucket_bytes=31457280, 모든 *_ok=true. 문서 건수는 적용 전후 동일합니다.
select b.file_size_limit as bucket_bytes,
  b.file_size_limit=31457280 as bucket_limit_ok,
  not b.public as private_bucket_ok,
  pg_get_constraintdef(c.oid) as file_size_check,
  c.convalidated and pg_get_constraintdef(c.oid)='CHECK (((file_size > 0) AND (file_size <= 31457280)))' as check_limit_ok,
  position('size_value>31457280' in p.prosrc)>0 and position('20971520' in p.prosrc)=0 as rpc_limit_ok,
  position('30MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.' in p.prosrc)>0 as rpc_message_ok,
  (select count(*) from private.member_interviews) as document_count
from storage.buckets b
join pg_constraint c on c.conrelid='private.member_interviews'::regclass and c.conname='member_interviews_file_size_check'
join pg_proc p on p.oid=to_regprocedure('private.create_member_interview(uuid,text,text)')
where b.id='member-interviews';
