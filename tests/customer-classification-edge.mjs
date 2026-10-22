// Every Auth/REST/OpenAI request uses a local transport. No server changes.
import assert from 'node:assert/strict';
import {createHandler,CLASSIFICATION_MODEL,CLASSIFICATION_SCHEMA,validateAssignments} from '../supabase/functions/classify-customer-labels/index.ts';
const user='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',member='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',lease='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const labels=[{label_key:'골프동호회회원',label:'골프 동호회 회원',member_ids:[member]},{label_key:'개원예정치과의사',label:'개원 예정 치과의사',member_ids:[member]}];
const groups=[{name:'부모·가족',examples:['가족 외식 손님']},{name:'숙박·병원·상가 사업주',examples:['개원 준비 의료인']}];
const output={assignments:labels.map(row=>({label_key:row.label_key,group_name:row.label.includes('치과')?groups[1].name:groups[0].name,fallback_group:groups[0].name,reason:'고객의 성격에 따른 분류'}))};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
function setup(options={}){
  const log=[],env={SUPABASE_URL:'https://test.supabase.co',SUPABASE_ANON_KEY:'anon-test',SUPABASE_SERVICE_ROLE_KEY:'service-test',OPENAI_API_KEY:'ai-test',...options.env};
  const fetch=async(url,init={})=>{
    const path=new URL(url).pathname,body=init.body?JSON.parse(init.body):null;log.push({path,body,headers:init.headers});
    if(path==='/auth/v1/user')return response({id:user,email:'member@example.test',email_confirmed_at:options.unconfirmed?null:'2026-10-22',user_metadata:{role:'admin'},...options.user},options.unauthorized?401:200);
    if(path==='/rest/v1/member_accounts')return response([{role:options.role||'admin',member_id:options.unlinked?null:member}]);
    if(path.endsWith('/begin_customer_label_classification'))return response(options.start||{lease_id:lease,labels,groups});
    if(path==='/v1/responses'){
      if(options.networkFailure)throw new Error('SECRET upstream failure');
      return response(options.ai||{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(options.output||output)}]}]},options.aiStatus||200);
    }
    if(path.endsWith('/finish_customer_label_classification'))return response(options.stale?{code:'40001'}:{classified:body.assignments.length,groups:groups.length},options.stale?409:200);
    if(path.endsWith('/cancel_customer_label_classification'))return response(null);
    throw new Error('Unexpected request '+path);
  };
  const handler=createHandler({fetch,env:key=>env[key]});
  const call=({origin='https://woolim0109.github.io',authorization='Bearer user-jwt',method='POST',body={}}={})=>handler(new Request('https://test.supabase.co/functions/v1/classify-customer-labels',{method,headers:{Origin:origin,Authorization:authorization,'Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(body)}:{})}));
  return {call,log};
}
let count=0;async function test(name,run){await run();count++;console.log('PASS '+name);}
await test('Authenticated admins and approved members automatically classify the two requested new expressions',async()=>{
  for(const role of ['admin','member']){const s=setup({role}),r=await s.call();assert.equal(r.status,200);assert.equal((await r.json()).classified,2);const saved=s.log.find(row=>row.path.endsWith('/finish_customer_label_classification'));assert.deepEqual(saved.body.assignments,output.assignments);}
});
await test('Authorization checks real verified users and current DB roles before using the service capability',async()=>{
  for(const options of [{unauthorized:true},{unconfirmed:true},{role:'viewer'},{role:'member',unlinked:true},{user:{is_anonymous:true}}]){
    const s=setup(options);assert([401,403].includes((await s.call()).status));assert(!s.log.some(row=>row.path.includes('/rpc/')||row.path==='/v1/responses'));
  }
});
await test('Disallowed origins, missing JWTs, unsupported methods and arbitrary client labels cannot trigger AI',async()=>{
  for(const call of [{origin:'https://evil.test'},{authorization:''},{method:'GET'},{body:{labels:['injected'],groups:['injected']}}]){
    const s=setup();assert((await s.call(call)).status>=400);assert(!s.log.some(row=>row.path==='/v1/responses'));
  }
  assert.equal((await setup().call({method:'OPTIONS'})).status,204);
});
await test('Browser preflight permits every header sent by the configured Supabase client without invoking AI',async()=>{
  const s=setup(),r=await s.call({method:'OPTIONS'});
  assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),'https://woolim0109.github.io');
  const allowed=new Set(r.headers.get('Access-Control-Allow-Headers').split(',').map(value=>value.trim().toLowerCase()));
  for(const header of ['authorization','apikey','content-type','x-client-info','x-sunshine-client'])assert(allowed.has(header),header+' must pass browser preflight');
  assert.equal(s.log.length,0);
});
await test('Missing secrets preserve stored customer labels without calling AI or the worker',async()=>{
  for(const key of ['OPENAI_API_KEY','SUPABASE_SERVICE_ROLE_KEY']){const s=setup({env:{[key]:''}});assert.equal((await s.call()).status,503);assert(!s.log.some(row=>row.path.includes('/rpc/')||row.path==='/v1/responses'));}
});
await test('The model receives only public type labels, counts and group examples using strict structured output',async()=>{
  const s=setup();await s.call();const request=s.log.find(row=>row.path==='/v1/responses').body;
  assert.equal(request.model,CLASSIFICATION_MODEL);assert.equal(request.store,false);assert.deepEqual(request.text.format.schema,CLASSIFICATION_SCHEMA);assert.equal(request.text.format.strict,true);
  const context=JSON.parse(request.input[0].content[0].text);assert.deepEqual(context.labels.map(row=>row.member_count),[1,1]);
  assert.deepEqual(context.labels.map(row=>row.member_refs),[['m1'],['m1']],'Multiple labels from the same person have the same per-request anonymous reference.');
  assert(!JSON.stringify(context).includes(member));assert(!JSON.stringify(context).includes(user));assert(!JSON.stringify(context).includes('member_ids'));
  assert(s.log.filter(row=>row.path.includes('/rpc/')).every(row=>row.headers.Authorization==='Bearer service-test'));assert.equal(s.log[0].headers.Authorization,'Bearer user-jwt');
});
await test('Anonymous per-request references distinguish two people using different expressions without sending their UUIDs',async()=>{
  const second='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  const s=setup({start:{lease_id:lease,groups,labels:[labels[0],{...labels[1],member_ids:[second]}]}});await s.call();
  const context=JSON.parse(s.log.find(row=>row.path==='/v1/responses').body.input[0].content[0].text);
  assert.deepEqual(context.labels.map(row=>row.member_refs),[['m1'],['m2']]);assert(!JSON.stringify(context).includes(second));
});
await test('Busy or unchanged snapshots avoid duplicate model requests',async()=>{
  for(const start of [{busy:true},{unchanged:true}]){const s=setup({start});assert.equal((await s.call()).status,200);assert(!s.log.some(row=>row.path==='/v1/responses'));}
});
await test('Malformed snapshots cancel a valid lease and never send unrelated objects to the model',async()=>{
  const s=setup({start:{lease_id:lease,labels:[{label_key:'bad',label:'bad',member_ids:[]}],groups}});assert.equal((await s.call()).status,502);assert(s.log.some(row=>row.path.endsWith('/cancel_customer_label_classification')));assert(!s.log.some(row=>row.path==='/v1/responses'));
});
await test('Model refusal, truncation, transport failures and upstream errors release leases for later loads',async()=>{
  for(const options of [{networkFailure:true},{aiStatus:429},{ai:{status:'incomplete',output:[]}},{ai:{status:'completed',output:[{type:'message',content:[{type:'refusal',refusal:'No'}]}]}}]){
    const s=setup(options),r=await s.call();assert.equal(r.status,502);assert(s.log.some(row=>row.path.endsWith('/cancel_customer_label_classification')));assert(!s.log.some(row=>row.path.endsWith('/finish_customer_label_classification')));assert(!(await r.text()).includes('SECRET'));
  }
});
await test('Every label is classified exactly once with an existing fallback; arbitrary keys and invalid output are rejected',async()=>{
  const invalid=[{}, {assignments:[]},{assignments:[output.assignments[0],output.assignments[0]]},{assignments:output.assignments.map(row=>({...row,fallback_group:'nonexistent'}))},{assignments:output.assignments.map(row=>({...row,group_name:'기타'}))},{assignments:output.assignments.map(row=>({...row,reason:'가'.repeat(501)}))}];
  for(const value of invalid)assert.throws(()=>validateAssignments(value,labels,groups));
  const s=setup({output:invalid[2]});assert.equal((await s.call()).status,502);assert(s.log.some(row=>row.path.endsWith('/cancel_customer_label_classification')));
});
await test('Stale DB snapshots release their lease without changing members or accepting an obsolete classification',async()=>{
  const s=setup({stale:true});assert.equal((await s.call()).status,409);assert(s.log.some(row=>row.path.endsWith('/cancel_customer_label_classification')));
  assert(!s.log.some(row=>row.path==='/rest/v1/members'));
});
console.log(`All ${count} customer classification Edge checks passed with isolated transports.`);
