-- 필요할 때만 수동 실행: 버킷 / CHECK / 등록 함수의 30MB 한도를 기존 20MB로 복원합니다.
-- 20MB 초과 원본이 있으면 전체 중단합니다. 파일·문서·검토 이력을 삭제하지 않습니다.
-- 업로드 작업이 없는 때 실행하세요. 새 컬럼·테이블·함수·권한을 추가하지 않습니다.
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
  oversized_documents bigint;
  oversized_objects bigint;
  old_message constant text := '20MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.';
  new_message constant text := '30MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.';
begin
  lock table private.member_interviews in access exclusive mode;
  select file_size_limit into bucket_limit from storage.buckets where id='member-interviews' for update;
  if not found or bucket_limit is null or bucket_limit not in (20971520,31457280) then
    raise exception 'member-interviews 버킷의 기존 20MB/30MB 설정을 확인하세요. 복원하지 않았습니다.';
  end if;
  select pg_get_constraintdef(oid),convalidated into constraint_text,constraint_valid
    from pg_constraint where conrelid='private.member_interviews'::regclass
      and conname='member_interviews_file_size_check' and contype='c';
  if not found or not constraint_valid or constraint_text not in (
    'CHECK (((file_size > 0) AND (file_size <= 20971520)))',
    'CHECK (((file_size > 0) AND (file_size <= 31457280)))'
  ) then
    raise exception '문서 file_size CHECK가 예상 정의와 다릅니다. 복원하지 않았습니다.';
  end if;
  if function_id is null then raise exception '기존 문서 등록 함수를 찾지 못했습니다. 복원하지 않았습니다.'; end if;
  select prosrc,pg_get_functiondef(oid) into function_body,function_definition from pg_proc where oid=function_id;
  if position('size_value>31457280' in function_body)>0
    and length(function_body)-length(replace(function_body,'31457280',''))=8
    and position('20971520' in function_body)=0
    and length(function_body)-length(replace(function_body,new_message,''))=length(new_message)
    and position(old_message in function_body)=0 then
    replacement_definition:=replace(replace(function_definition,'size_value>31457280','size_value>20971520'),new_message,old_message);
    if replace(replace(replacement_definition,'size_value>20971520','size_value>31457280'),old_message,new_message)<>function_definition then
      raise exception '함수 복원이 용량 숫자·안내문구에 한정되지 않습니다. 복원하지 않았습니다.';
    end if;
  elsif position('size_value>20971520' in function_body)>0
    and length(function_body)-length(replace(function_body,'20971520',''))=8
    and position('31457280' in function_body)=0
    and length(function_body)-length(replace(function_body,old_message,''))=length(old_message)
    and position(new_message in function_body)=0 then
    replacement_definition:=null;
  else
    raise exception '문서 등록 함수의 기존 한도·문구를 확인하세요. 복원하지 않았습니다.';
  end if;
  select count(*) into oversized_documents from private.member_interviews where file_size>20971520;
  select count(*) into oversized_objects from storage.objects where bucket_id='member-interviews'
    and case when coalesce(metadata->>'size','') ~ '^[0-9]+$' then (metadata->>'size')::numeric>20971520 else false end;
  if oversized_documents>0 or oversized_objects>0 then
    raise exception '20MB 초과 문서 %개 / 보관 원본 %개가 있어 복원을 중단합니다. 기존 원본을 삭제하지 않았습니다.',oversized_documents,oversized_objects;
  end if;

  if position('31457280' in constraint_text)>0 then
    alter table private.member_interviews drop constraint member_interviews_file_size_check;
    execute 'alter table private.member_interviews add constraint member_interviews_file_size_check '
      ||replace(constraint_text,'31457280','20971520');
  end if;
  if replacement_definition is not null then execute replacement_definition; end if;
  update storage.buckets set file_size_limit=20971520 where id='member-interviews' and file_size_limit<>20971520;
end $pdf_limit$;
commit;

-- 복원 확인: 1행, bucket_bytes=20971520, 모든 *_ok=true.
select b.file_size_limit as bucket_bytes,
  b.file_size_limit=20971520 as bucket_limit_ok,
  not b.public as private_bucket_ok,
  pg_get_constraintdef(c.oid) as file_size_check,
  c.convalidated and pg_get_constraintdef(c.oid)='CHECK (((file_size > 0) AND (file_size <= 20971520)))' as check_limit_ok,
  position('size_value>20971520' in p.prosrc)>0 and position('31457280' in p.prosrc)=0 as rpc_limit_ok,
  position('20MB 이하 PDF·DOCX·텍스트 파일만 등록할 수 있습니다.' in p.prosrc)>0 as rpc_message_ok,
  (select count(*) from private.member_interviews) as document_count
from storage.buckets b
join pg_constraint c on c.conrelid='private.member_interviews'::regclass and c.conname='member_interviews_file_size_check'
join pg_proc p on p.oid=to_regprocedure('private.create_member_interview(uuid,text,text)')
where b.id='member-interviews';
