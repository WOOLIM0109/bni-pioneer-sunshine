// Local PostgreSQL regression checks. No network, credentials, real Storage, or AI requests.
// Run: node tests/interview-pdf-limits.mjs
// Optional: PGLITE_MODULE points to an existing @electric-sql/pglite/dist/index.js.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const moduleURL=process.env.PGLITE_MODULE?pathToFileURL(path.resolve(process.env.PGLITE_MODULE)):new URL('../.codex-tmp/roles-validation/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url);
const {PGlite}=await import(moduleURL.href);
const db=new PGlite(), MiB=1024*1024, oldLimit=20*MiB, newLimit=30*MiB;
const admin='33333333-3333-4333-8333-333333333301',member='33333333-3333-4333-8333-333333333302',viewer='33333333-3333-4333-8333-333333333303',unconfirmed='33333333-3333-4333-8333-333333333304';
const memberId='44444444-4444-4444-8444-444444444401';
const createSignature='private.create_member_interview(uuid,text,text)';
const tables=['auth.users','public.members','public.member_accounts','private.member_details','private.member_interviews','private.member_interview_history','private.member_interview_reviews','private.member_interview_review_history','storage.buckets','storage.objects'];
let checks=0,sequence=0,inTransaction=false;
const read=filename=>readFile(path.join(root,filename),'utf8');
const query=async(sql,values=[])=> (await db.query(sql,values)).rows;
function pass(label){checks++;console.log('PASS '+label);}
async function rejects(action,code,label){await assert.rejects(action,error=>error.code===code,label);pass(label);}
async function asUser(user,action){
  const savepoint=inTransaction?'user_check_'+(++sequence):null;if(savepoint)await db.exec('savepoint '+savepoint);
  await db.exec(`set role ${user?'authenticated':'anon'}`);
  await query("select set_config('request.jwt.claims',$1,false)",[JSON.stringify(user?{sub:user,role:'authenticated',user_metadata:{role:'admin'}}:{role:'anon'})]);
  try{return await action();}catch(error){if(savepoint)await db.exec('rollback to savepoint '+savepoint);throw error;}
  finally{await db.exec('reset role');await query("select set_config('request.jwt.claims','{}',false)");if(savepoint)await db.exec('release savepoint '+savepoint);}
}
async function isolated(action){await db.exec('begin');inTransaction=true;try{return await action();}finally{await db.exec('rollback');inTransaction=false;}}
async function object(size,mime='application/pdf',bucket='member-interviews'){
  const name=memberId+'/fixture-'+(++sequence)+'.pdf';
  await query('insert into storage.objects(bucket_id,name,metadata) values($1,$2,$3)',[bucket,name,{size,mimetype:mime}]);return name;
}
async function create(name){return (await query('select public.create_member_interview($1,$2,$3) as value',[memberId,name,'fixture.pdf']))[0].value;}
async function directDocument(size){return (await query(`insert into private.member_interviews(member_id,storage_path,original_name,mime_type,file_size,raw_text)
  values($1,$2,'direct.pdf','application/pdf',$3,'synthetic retained text') returning id`,[memberId,memberId+'/direct-'+(++sequence)+'.pdf',size]))[0].id;}
async function dataSnapshot(){
  const result={};for(const table of tables)result[table]=(await query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`)).map(item=>item.row);
  return result;
}
async function catalogSnapshot(){
  return {
    functions:await query(`select n.nspname as schema,p.proname,p.oid::regprocedure::text as signature,pg_get_functiondef(p.oid) as definition,p.proacl::text as acl,p.proowner,p.prosecdef,p.proconfig
      from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in ('public','private') order by 1,2,3`),
    columns:await query(`select n.nspname,c.relname,a.attname,a.attnum,format_type(a.atttypid,a.atttypmod) as type,a.attnotnull,a.attidentity,pg_get_expr(d.adbin,d.adrelid) as default_value
      from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where n.nspname in ('public','private','storage') and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped order by 1,2,4`),
    tables:await query(`select n.nspname,c.relname,c.relrowsecurity,c.relforcerowsecurity,c.relacl::text as acl from pg_class c join pg_namespace n on n.oid=c.relnamespace
      where n.nspname in ('public','private','storage') and c.relkind in ('r','p','S') order by 1,2`),
    policies:await query(`select * from pg_policies where schemaname in ('public','private','storage') order by schemaname,tablename,policyname`),
    triggers:await query(`select n.nspname,c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition,t.tgenabled from pg_trigger t join pg_class c on c.oid=t.tgrelid
      join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') and not t.tgisinternal order by 1,2,3`),
    constraints:await query(`select n.nspname,c.relname,k.conname,k.contype,pg_get_constraintdef(k.oid) as definition,k.convalidated from pg_constraint k
      join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname in ('public','private','storage') order by 1,2,3`)
  };
}
function normalizeCatalog(value){
  const result=structuredClone(value);
  for(const fn of result.functions)if(fn.signature===createSignature)fn.definition=fn.definition.replaceAll('size_value>'+newLimit,'size_value>'+oldLimit).replaceAll('30MB 이하','20MB 이하');
  for(const constraint of result.constraints)if(constraint.nspname==='private'&&constraint.relname==='member_interviews'&&constraint.conname==='member_interviews_file_size_check')constraint.definition=constraint.definition.replaceAll(String(newLimit),String(oldLimit));
  return result;
}
function normalizeData(value){
  const result=structuredClone(value);for(const bucket of result['storage.buckets'])if(bucket.id==='member-interviews')bucket.file_size_limit=oldLimit;return result;
}
async function assertLimit(limit){
  const bucket=(await query("select * from storage.buckets where id='member-interviews'"))[0];
  assert.equal(Number(bucket.file_size_limit),limit);assert.equal(bucket.public,false);
  assert.deepEqual(bucket.allowed_mime_types,['application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain']);
  const constraint=(await query("select pg_get_constraintdef(oid) as definition from pg_constraint where conrelid='private.member_interviews'::regclass and conname='member_interviews_file_size_check'"))[0];
  assert(constraint?.definition.includes(String(limit)), 'Document CHECK must use the expected byte limit');
  const definition=(await query('select pg_get_functiondef($1::regprocedure) as definition',[createSignature]))[0].definition;
  assert(definition.includes('size_value>'+limit),'RPC must validate authoritative Storage metadata against the expected byte limit');
  assert(definition.includes((limit/MiB)+'MB 이하'),'RPC rejection message must match the byte limit');
}
async function assertVerification(results,limit){
  // The migration's final SELECT is part of the administrator-facing contract.
  const sets=results.filter(result=>result.rows?.length);
  assert(sets.length,'Migration must return a verification SELECT');
  const rows=sets.flatMap(result=>result.rows).filter(row=>'bucket_bytes' in row);
  assert.equal(rows.length,1,'Verification SELECT must return exactly one bucket row');
  assert.equal(Number(rows[0].bucket_bytes),limit);
  for(const key of ['bucket_limit_ok','private_bucket_ok','check_limit_ok','rpc_limit_ok','rpc_message_ok'])assert.equal(rows[0][key],true,'Verification SELECT '+key);
  assert.equal(Number(rows[0].document_count),(await query('select count(*)::int as count from private.member_interviews'))[0].count);
}
async function runMigration(sql,limit){const results=await db.exec(sql);await assertVerification(results,limit);await assertLimit(limit);}
async function blockedMigration(sql,label){
  const beforeData=await dataSnapshot(),beforeCatalog=await catalogSnapshot();
  await assert.rejects(()=>db.exec(sql),error=>error.code==='P0001',label);
  await db.exec('rollback');
  assert.deepEqual(await dataSnapshot(),beforeData,'Blocked rollback must preserve every stored row');
  assert.deepEqual(await catalogSnapshot(),beforeCatalog,'Blocked rollback must preserve all schema and permissions');
  pass(label);
}
async function setPartialLimits(mask){
  await query("update storage.buckets set file_size_limit=$1 where id='member-interviews'",[mask&1?newLimit:oldLimit]);
  await db.exec(`alter table private.member_interviews drop constraint member_interviews_file_size_check;
    alter table private.member_interviews add constraint member_interviews_file_size_check check(file_size>0 and file_size<=${mask&2?newLimit:oldLimit});`);
  const definition=(await query('select pg_get_functiondef($1::regprocedure) as definition',[createSignature]))[0].definition;
  await db.exec(definition.replace(/size_value>(?:20971520|31457280)/g,'size_value>'+(mask&4?newLimit:oldLimit)).replace(/(?:20|30)MB 이하/g,(mask&4?'30':'20')+'MB 이하'));
}

try{
  await db.exec(`
    create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
    create schema auth; grant usage on schema auth to anon,authenticated,service_role;
    create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz,is_anonymous boolean default false,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid; $$;
    create schema storage; grant usage on schema storage to anon,authenticated,service_role;
    create table storage.buckets(id text primary key,name text not null,public boolean default false,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text references storage.buckets(id),name text,metadata jsonb,unique(bucket_id,name));
    alter table storage.objects enable row level security; grant select,insert,update,delete on storage.objects to anon,authenticated;
  `);
  for(const filename of ['supabase/schema.sql','supabase/roles.sql'])await db.exec(await read(filename));
  // Canonical fresh installs may already use 30MiB. Keep a genuine old 20MiB database for upgrade coverage.
  const legacy=(await read('supabase/interviews.sql')).replaceAll(String(newLimit),String(oldLimit)).replaceAll('30MB 이하','20MB 이하');
  await db.exec(legacy);await db.exec(await read('supabase/interview-reviews.sql'));
  // A same-valued number outside the function body must not be rewritten by the focused migration.
  await db.exec('alter function '+createSignature+' cost '+oldLimit);
  const forward=await read('supabase/interview-pdf-30mb.sql'),rollback=await read('supabase/interview-pdf-30mb-rollback.sql');
  for(const sql of [forward,rollback])assert(/\bbegin\s*;/i.test(sql)&&/\bcommit\s*;/i.test(sql),'Both scripts must be transactional');
  await query(`insert into auth.users(id,email,email_confirmed_at) values($1,'admin@example.invalid',now()),($2,'member@example.invalid',now()),($3,'viewer@example.invalid',now()),($4,'unconfirmed@example.invalid',null)`,[admin,member,viewer,unconfirmed]);
  await query("insert into public.members(id,name,company,customers) values($1,'Synthetic PDF member','Retained company',array['Retained customer'])",[memberId]);
  await query("update public.member_accounts set role='admin' where user_id=any($1::uuid[])",[[admin,unconfirmed]]);
  await query("update public.member_accounts set role='member',member_id=$1 where user_id=$2",[memberId,member]);
  await query("insert into private.member_details(member_id,good_referral,triggers,revision) values($1,'Retained referral',array['Retained trigger'],9)",[memberId]);
  await query("insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('unrelated','unrelated',true,999999999,array['application/octet-stream'])");
  await object(newLimit+1,'application/octet-stream','unrelated');
  const originalPath=await object(oldLimit),original=await asUser(admin,()=>create(originalPath));
  await asUser(admin,()=>query('select public.save_member_interview_draft($1,1,$2)',[original.id,{raw_text:'Retained source text',stages:['credibility']}]));
  await query(`insert into private.member_interview_reviews(member_id,source_interview_ids,source_revisions,source_documents,extracted,public_patch,private_patch,status,revision)
    values($1,array[$2::uuid],jsonb_build_object($2::text,2),jsonb_build_array(jsonb_build_object('id',$2::text,'original_name','fixture.pdf')),'{"summary":"Retained review","suggestions":[]}','{"customers":["Retained proposal"]}','{"good_referral":"Retained private proposal"}','applied',7)`,[memberId,original.id]);
  await query("insert into private.member_interview_review_history(review_id,revision,action,snapshot) select id,revision,'applied',to_jsonb(r) from private.member_interview_reviews r");
  await assertLimit(oldLimit);pass('Legacy bucket, table CHECK, and create RPC start at 20MiB');
  await isolated(async()=>{
    const name=await object(oldLimit+1);await rejects(()=>asUser(admin,()=>create(name)),'22023','Legacy RPC rejects 20MiB + 1 byte');
    await rejects(()=>directDocument(oldLimit+1),'23514','Legacy table CHECK rejects 20MiB + 1 byte');
  });
  const initialData=await dataSnapshot(),initialCatalog=await catalogSnapshot();
  await db.exec(`create function private.pdf_limit_test_fail_bucket() returns trigger language plpgsql as $$begin raise exception 'synthetic final bucket write failure';end$$;
    create trigger pdf_limit_test_fail_bucket before update on storage.buckets for each row execute function private.pdf_limit_test_fail_bucket();`);
  await blockedMigration(forward,'A final bucket-write failure rolls back preceding CHECK and function changes');
  await db.exec('drop trigger pdf_limit_test_fail_bucket on storage.buckets; drop function private.pdf_limit_test_fail_bucket()');
  assert.deepEqual(await dataSnapshot(),initialData);assert.deepEqual(await catalogSnapshot(),initialCatalog);
  await runMigration(forward,newLimit);
  assert.deepEqual(normalizeData(await dataSnapshot()),normalizeData(initialData));
  assert.deepEqual(normalizeCatalog(await catalogSnapshot()),normalizeCatalog(initialCatalog));
  pass('Upgrade changes only the three size limits and message; all data, columns, functions, grants, and policies survive');
  const firstData=await dataSnapshot(),firstCatalog=await catalogSnapshot();
  await runMigration(forward,newLimit);assert.deepEqual(await dataSnapshot(),firstData);assert.deepEqual(await catalogSnapshot(),firstCatalog);
  pass('Upgrade rerun is idempotent and verification SELECT reports 30MiB');
  for(const size of [1,newLimit])await isolated(async()=>{
    const name=await object(size),row=await asUser(admin,()=>create(name));assert.equal(row.file_size,size);assert.equal(row.member_id,memberId);assert.equal(row.mime_type,'application/pdf');
    pass('Admin RPC accepts '+size+' bytes from authoritative PDF Storage metadata');
  });
  for(const [size,mime,label] of [[newLimit+1,'application/pdf','30MiB + 1 byte'],[0,'application/pdf','empty file'],[-1,'application/pdf','negative metadata size'],['invalid','application/pdf','invalid metadata size'],[100,'application/octet-stream','unsupported MIME despite PDF display name']])await isolated(async()=>{
    const name=await object(size,mime);await rejects(()=>asUser(admin,()=>create(name)),'22023','RPC rejects '+label);
  });
  for(const mime of ['application/vnd.openxmlformats-officedocument.wordprocessingml.document','text/plain'])await isolated(async()=>{
    const name=await object(oldLimit,mime),row=await asUser(admin,()=>create(name));assert.equal(row.mime_type,mime);pass('Existing non-PDF MIME support remains compatible: '+mime);
  });
  await isolated(async()=>{await directDocument(newLimit);pass('Table CHECK independently accepts exactly 30MiB');});
  for(const size of [0,newLimit+1])await isolated(()=>rejects(()=>directDocument(size),'23514','Table CHECK independently rejects '+size+' bytes'));
  for(const [user,label] of [[null,'anonymous'],[viewer,'viewer with forged admin metadata'],[member,'linked member'],[unconfirmed,'unconfirmed administrator']]){
    await rejects(()=>asUser(user,()=>create(originalPath)),'42501',label+' cannot register source documents');
    await rejects(()=>asUser(user,()=>query('select * from private.member_interviews')),'42501',label+' cannot directly read private documents');
    await rejects(()=>asUser(user,()=>query("insert into storage.objects(bucket_id,name,metadata) values('member-interviews',$1,'{}')",[memberId+'/forbidden-'+(++sequence)+'.pdf'])),'42501',label+' cannot upload private source objects');
    assert.equal((await asUser(user,()=>query("select count(*)::int as count from storage.objects where bucket_id='member-interviews'")))[0].count,0);pass(label+' cannot read private source objects');
  }
  await rejects(()=>asUser(admin,()=>create(originalPath)),'23505','Duplicate original path still cannot create a second document');
  assert.deepEqual(await dataSnapshot(),firstData);pass('Boundary and permission checks leave retained documents, reviews, history, and members unchanged');
  await runMigration(rollback,oldLimit);assert.deepEqual(await dataSnapshot(),initialData);assert.deepEqual(await catalogSnapshot(),initialCatalog);
  pass('Rollback restores all original limits without changing retained data or permissions');
  await runMigration(rollback,oldLimit);assert.deepEqual(await dataSnapshot(),initialData);assert.deepEqual(await catalogSnapshot(),initialCatalog);
  pass('Rollback rerun is idempotent and verification SELECT reports 20MiB');
  await runMigration(forward,newLimit);
  const largeDocument=await directDocument(oldLimit+1);
  await blockedMigration(rollback,'A registered document above 20MiB aborts the entire rollback');await assertLimit(newLimit);
  await query('delete from private.member_interviews where id=$1',[largeDocument]);
  for(const size of [oldLimit+1,String(oldLimit+1)]){
    const largeObject=await object(size);await blockedMigration(rollback,'An unregistered Storage object above 20MiB aborts the entire rollback ('+typeof size+' metadata)');await assertLimit(newLimit);
    await query("delete from storage.objects where bucket_id='member-interviews' and name=$1",[largeObject]);
  }
  await runMigration(rollback,oldLimit);assert.deepEqual(await dataSnapshot(),initialData);assert.deepEqual(await catalogSnapshot(),initialCatalog);
  pass('Rollback succeeds after oversized test fixtures are removed and ignores unrelated buckets');
  for(let mask=1;mask<7;mask++){
    await setPartialLimits(mask);await runMigration(rollback,oldLimit);
    assert.deepEqual(await dataSnapshot(),initialData);assert.deepEqual(await catalogSnapshot(),initialCatalog);
    await setPartialLimits(mask);await runMigration(forward,newLimit);
    assert.deepEqual(await dataSnapshot(),firstData);assert.deepEqual(await catalogSnapshot(),firstCatalog);
    await runMigration(rollback,oldLimit);
    pass('Known mixed 20/30MiB state '+mask+' can upgrade or roll back without changing unrelated function COST or data');
  }
  const originalDefinition=(await query('select pg_get_functiondef($1::regprocedure) as definition',[createSignature]))[0].definition;
  const invalidStates=[
    ['unknown bucket limit',()=>query("update storage.buckets set file_size_limit=12345 where id='member-interviews'")],
    ['unexpected CHECK definition',()=>db.exec('alter table private.member_interviews drop constraint member_interviews_file_size_check; alter table private.member_interviews add constraint member_interviews_file_size_check check(file_size>0 and file_size<=20971520 and file_size<>123)')],
    ['unexpected RPC comparison',()=>db.exec(originalDefinition.replace('size_value>20971520','size_value>=20971520'))]
  ];
  for(const [label,alter] of invalidStates){
    await alter();await blockedMigration(forward,'Upgrade rejects '+label+' without partial changes');await blockedMigration(rollback,'Rollback rejects '+label+' without partial changes');
    await setPartialLimits(0);await db.exec(originalDefinition);
    assert.deepEqual(await dataSnapshot(),initialData);assert.deepEqual(await catalogSnapshot(),initialCatalog);
  }
  console.log(`${checks} local PGlite checks passed. No external database, Storage HTTP, or AI calls; Storage HTTP enforcement is represented by bucket metadata.`);
}catch(error){console.error(JSON.stringify({message:error.message,code:error.code,detail:error.detail}));process.exitCode=1;}
finally{await db.close();}
