// Isolated PostgreSQL: applies local SQL files only, never connects to Supabase.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {createHandler} from '../supabase/functions/classify-customer-labels/index.ts';
const moduleURL=process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE):new URL('../.codex-tmp/customer-map-validation/node_modules/@electric-sql/pglite/dist/index.js',import.meta.url);
const {PGlite}=await import(moduleURL.href),db=new PGlite();
const sql=await readFile(new URL('../supabase/customer-group-map-apply.sql',import.meta.url),'utf8');
const verify=await readFile(new URL('../supabase/customer-group-map-verify.sql',import.meta.url),'utf8');
const rollback=await readFile(new URL('../supabase/customer-group-map-rollback.sql',import.meta.url),'utf8');
const ids=['00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002'];
let checks=0;const pass=label=>{checks++;console.log('PASS '+label);};
const query=async(text,args=[])=> (await db.query(text,args)).rows;
const scalar=async(text,args=[])=>Object.values((await query(text,args))[0])[0];
const begin=()=>scalar('select public.begin_customer_label_classification()');
const cancel=lease=>query('select public.cancel_customer_label_classification($1)',[lease]);
const finish=(lease,assignments)=>scalar('select public.finish_customer_label_classification($1,$2)',[lease,JSON.stringify(assignments)]);
const assignment=(row,group='부모·가족')=>({label_key:row.label_key,group_name:group,fallback_group:'부모·가족',reason:'공개 고객 유형의 성격'});
async function denied(role,text,args=[]){await db.exec('set role '+role);try{await assert.rejects(()=>query(text,args),error=>error.code==='42501');}finally{await db.exec('reset role');}}
try{
  await db.exec('create role anon; create role authenticated; create role service_role bypassrls; create table public.members(id uuid primary key, customers text[] not null);');
  await query('insert into public.members values($1,$2),($3,$4)',[ids[0],['부모·가족'],ids[1],['개원 준비 의료인']]);
  const before=await query('select * from public.members order by id');
  await db.exec(sql);await db.exec(sql);assert.equal(await scalar('select count(*)::int from public.customer_groups'),17);assert.deepEqual(await query('select * from public.members order by id'),before);pass('Apply and reapply seed 17 groups without changing members');
  assert.equal(await scalar("select public.customer_label_key(' 부 모 ㆍ 가 족 ')=public.customer_label_key('부모·가족')"),true);pass('PostgreSQL normalization matches whitespace and middle-dot aliases');
  for(const role of ['anon','authenticated']){
    await denied(role,"insert into public.customer_groups values('침입',99,false,now())");
    await denied(role,"update public.customer_group_map set group_name='부모·가족'");
    await denied(role,'select public.begin_customer_label_classification()');
    await denied(role,'select public.finish_customer_label_classification(null,null)');
    await db.exec('set role '+role);assert.equal(await scalar('select count(*)::int from public.customer_groups'),17);await db.exec('reset role');
  }pass('Public map reading works; browser roles cannot change mappings or invoke worker capabilities');
  assert.deepEqual(await begin(),{unchanged:true});
  await query('update public.members set customers=$2 where id=$1',[ids[0],['골프 동호회 회원','개원 예정 치과의사']]);
  let job=await begin();assert.equal(job.labels.length,2);assert.equal((await begin()).busy,true);pass('Only unknown/AI public labels enter a single exclusive lease');
  await assert.rejects(()=>finish(job.lease_id,null),error=>error.code==='22023');
  await assert.rejects(()=>finish(job.lease_id,job.labels.map(row=>({label_key:row.label_key,fallback_group:'부모·가족'}))),error=>error.code==='22023');
  await cancel(job.lease_id);
  const transport=async(url,init={})=>{
    const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):{};
    const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
    if(path==='/auth/v1/user')return response({id:ids[0],email:'member@example.test',email_confirmed_at:'2026-10-22'});
    if(path==='/rest/v1/member_accounts')return response([{role:'member',member_id:ids[0]}]);
    if(path==='/v1/responses'){
      const context=JSON.parse(body.input[0].content[0].text);
      return response({status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify({assignments:context.labels.map(row=>assignment(row,row.label.includes('치과')?'숙박·병원·상가 사업주':'취미·여가 모임'))})}]}]});
    }
    await db.exec('set role service_role');
    try{
      if(path.endsWith('/begin_customer_label_classification'))return response(await begin());
      if(path.endsWith('/finish_customer_label_classification'))return response(await finish(body.target_lease_id,body.assignments));
      if(path.endsWith('/cancel_customer_label_classification')){await cancel(body.target_lease_id);return response(null);}
      throw new Error('Unexpected path '+path);
    }finally{await db.exec('reset role');}
  };
  const handler=createHandler({fetch:transport,env:key=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'anon-test',SUPABASE_SERVICE_ROLE_KEY:'service-test',OPENAI_API_KEY:'ai-test'})[key]});
  const result=await handler(new Request('https://test.supabase.co/functions/v1/classify-customer-labels',{method:'POST',headers:{Authorization:'Bearer member-jwt','Content-Type':'application/json'},body:'{}'}));
  assert.equal(result.status,200);assert.equal((await result.json()).classified,2);pass('Real Edge handler and PostgreSQL RPCs persist the model transport response for both requested labels');
  assert.equal(await scalar("select group_name from public.customer_group_map where label='개원 예정 치과의사'"),'숙박·병원·상가 사업주');
  assert.equal(await scalar("select group_name from public.customer_group_map where label='골프 동호회 회원'"),'부모·가족');
  assert.equal(await scalar('select count(*)::int from public.customer_groups'),17);pass('One member cannot create a group by submitting multiple labels; closest existing fallbacks are stored');
  assert.deepEqual(await begin(),{unchanged:true});pass('Identical successful snapshots never incur another AI call');
  await query('update public.members set customers=$2 where id=$1',[ids[1],['골프 동호회 회원']]);
  job=await begin();assert.equal(job.labels.find(row=>row.label==='골프 동호회 회원').member_ids.length,2);
  await finish(job.lease_id,job.labels.map(row=>assignment(row,row.label.includes('골프')?'취미·여가 모임':'숙박·병원·상가 사업주')));
  assert.equal(await scalar('select count(*)::int from public.customer_groups'),18);
  assert.equal(await scalar("select group_name from public.customer_group_map where label='골프 동호회 회원'"),'취미·여가 모임');pass('An already-classified expression is reconsidered when a second distinct member uses it');
  await query("update public.members set customers=customers||array['보드게임 동호인'] where id=$1",[ids[0]]);
  job=await begin();await query("update public.members set customers=customers||array['탁구 동호인'] where id=$1",[ids[1]]);
  await assert.rejects(()=>finish(job.lease_id,job.labels.map(row=>assignment(row))),error=>error.code==='40001');await cancel(job.lease_id);pass('Concurrent member edits reject stale AI results without altering saved member data');
  job=await begin();await cancel(job.lease_id);assert((await begin()).lease_id);await query('update private.customer_classification_state set expires_at=now()-interval \'1 second\'');job=await begin();assert(job.lease_id);await cancel(job.lease_id);pass('Failure cancellation and lease expiry allow the next load to retry');
  await db.exec("insert into public.customer_groups(name,sort_order) values('검증 그룹 19',18),('검증 그룹 20',19)");
  job=await begin();await finish(job.lease_id,job.labels.map(row=>assignment(row,'상한 초과 제안')));assert.equal(await scalar('select count(*)::int from public.customer_groups'),20);
  assert.equal(await scalar("select count(*)::int from public.customer_group_map where group_name='상한 초과 제안'"),0);pass('At 20 groups, even a multi-member AI proposal uses its existing fallback');
  await db.exec(sql);assert.equal(await scalar("select group_name from public.customer_group_map where label='골프 동호회 회원'"),'부모·가족');pass('Reapplying at the cap preserves existing AI classifications');
  const results=await db.exec(verify);for(const row of results[0].rows)for(const [key,value]of Object.entries(row))if(key.endsWith('_ok'))assert.equal(value,true,key);pass('Operator verification SQL reports all security and integrity checks true');
  const savedMembers=await query('select * from public.members order by id');await db.exec(rollback);assert.deepEqual(await query('select * from public.members order by id'),savedMembers);assert.equal(await scalar("select to_regclass('public.customer_group_map') is null"),true);pass('Rollback removes only classification objects and preserves member data');
  await db.exec(rollback);pass('Rollback is repeatable');
  console.log(`All ${checks} customer-group SQL checks passed. No remote SQL was executed.`);
}catch(error){console.error({message:error.message,code:error.code,position:error.position,where:error.where,stack:error.code?undefined:error.stack});process.exitCode=1;}finally{await db.close();}
