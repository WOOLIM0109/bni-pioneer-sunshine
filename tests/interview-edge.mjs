// No network: every Auth, REST, Storage, and OpenAI call uses the test transport.
// Run: node --experimental-strip-types tests/interview-edge.mjs
import assert from 'node:assert/strict';
import {createHandler,INTERVIEW_MODEL,ANALYSIS_SCHEMA,ANALYSIS_LIMITS,DOCUMENT_LIMITS,validateAnalysis} from '../supabase/functions/analyze-interview/index.ts';
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',memberId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',interviewId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',leaseId='dddddddd-dddd-4ddd-8ddd-dddddddddddd',reviewId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',secondId='cccccccc-cccc-4ccc-8ccc-cccccccccccd',thirdId='cccccccc-cccc-4ccc-8ccc-ccccccccccce';
const output={summary:'인터뷰 요약',detected_name:'홍길동',warnings:[],suggestions:[{key:'customers',value:['제조업 대표'],reason:'사업 분야',evidence:'제조업 대표가 주요 고객입니다.',confidence:'high',basis:'stated',sources:[interviewId]}]};
const suggestion=(key,value,extra={})=>({...output.suggestions[0],key,value,...extra});
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function setup(options={}){
  const log=[],document={id:interviewId,member_id:memberId,revision:1,raw_text:'제조업 대표가 주요 고객입니다.',original_name:'아는 단계.txt',stages:['visibility'],created_at:'2026-09-21T00:00:00Z',mime_type:'text/plain',storage_path:memberId+'/source.txt',file_size:100,...options.document};
  const documents=options.documents||[document],review={id:reviewId,member_id:memberId,revision:1,status:'analyzing',source_interview_ids:documents.map(d=>d.id),...options.review};
  const fetch=async(url,init={})=>{
    const parsed=new URL(url),body=init.body?JSON.parse(init.body):null;
    log.push({path:parsed.pathname,query:parsed.search,body,headers:init.headers});
    if(parsed.pathname==='/auth/v1/user')return response(options.unauthorized?{}:{id:userId,email:'admin@example.test',email_confirmed_at:'2026-09-21T00:00:00Z',is_anonymous:false},options.unauthorized?401:200);
    if(parsed.pathname==='/rest/v1/member_accounts')return response([{role:options.role||'admin'}]);
    if(parsed.pathname==='/rest/v1/rpc/begin_member_interview_review_analysis')return options.beginError?response(options.beginError,400):options.busy?response({message:'analysis_in_progress'},409):response({lease_id:leaseId,expires_at:'2026-09-21T00:03:00Z',review,documents});
    if(parsed.pathname==='/rest/v1/members')return response([{id:memberId,name:'홍길동',company:'길동상사',field:'제조',team:'RETIRED-TEAM-SENTINEL',chapter_role:'OPERATIONS-ROLE-SENTINEL',customers:options.currentCustomers||[],synergies:[]}]);
    if(parsed.pathname.startsWith('/storage/v1/object/authenticated/'))return new Response(options.pdf||'%PDF-1.7\nfixture');
    if(parsed.pathname==='/v1/responses'){
      if(options.networkFailure)throw new Error('private-upstream-error');
      return response(options.aiResponse||{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(options.output||output)}]}]},options.aiStatus||200);
    }
    if(parsed.pathname==='/rest/v1/rpc/finish_member_interview_review_analysis')return options.staleFinish?response({message:'stale_revision'},409):response({...review,revision:2,status:'draft',...body.analysis});
    if(parsed.pathname==='/rest/v1/rpc/cancel_member_interview_review_analysis')return response({released:true});
    throw Error('Unexpected external call '+url);
  };
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-test-key',OPENAI_API_KEY:options.noKey?'':'private-test-key',...(options.allowedOrigins===undefined?{}:{ALLOWED_ORIGINS:options.allowedOrigins})};
  const diagnostics=[];
  const handler=createHandler({fetch,env:key=>env[key],diagnostic:entry=>diagnostics.push(entry)});
  const call=(method='POST',data={interview_ids:documents.map(d=>d.id)},origin='https://woolim0109.github.io')=>handler(new Request('https://example.supabase.co/functions/v1/analyze-interview',{method,headers:{Origin:origin,Authorization:'Bearer user-jwt','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(data)}:{})}));
  return {log,call,diagnostics,document};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
await test('GET configuration still requires admin',async()=>{const s=setup({role:'member'});assert.equal((await s.call('GET')).status,403);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);});
await test('GET missing key reports false without model call',async()=>{const s=setup({noKey:true});assert.deepEqual(await(await s.call('GET')).json(),{configured:false});assert.equal(s.log.length,2);});
await test('Disallowed origin rejects before reading auth or original',async()=>{const s=setup();assert.equal((await s.call('GET',undefined,'https://untrusted.example')).status,403);assert.equal(s.log.length,0);});
await test('Custom domain and existing Pages origin allow preflight without authentication or paid calls',async()=>{
  for(const origin of ['https://sunshine.bni-pioneer.com','https://woolim0109.github.io']){const s=setup(),r=await s.call('OPTIONS',undefined,origin);assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(r.headers.get('Vary'),'Origin');assert.match(r.headers.get('Access-Control-Allow-Methods'),/POST/);assert.equal(s.log.length,0);}
});
await test('Custom-domain configuration GET authenticates an admin without invoking AI',async()=>{
  const origin='https://sunshine.bni-pioneer.com',s=setup(),r=await s.call('GET',undefined,origin);assert.equal(r.status,200);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.deepEqual(await r.json(),{configured:true});assert.deepEqual(s.log.map(x=>x.path),['/auth/v1/user','/rest/v1/member_accounts']);
  const denied=setup({role:'member'});assert.equal((await denied.call('GET',undefined,origin)).status,403);assert.equal(denied.log.some(x=>x.path==='/v1/responses'),false);
});
await test('Ninth-term client header passes browser CORS preflight without Auth or model calls',async()=>{
  const calls=[],handler=createHandler({env:key=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'test-key'}[key]),fetch:async(...args)=>{calls.push(args);throw Error('Preflight must not make a network request.');}});
  const r=await handler(new Request('https://example.supabase.co/functions/v1/analyze-interview',{method:'OPTIONS',headers:{Origin:'https://woolim0109.github.io','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,apikey,content-type,x-client-info,x-sunshine-client'}}));
  assert.equal(r.status,204);assert(r.headers.get('Access-Control-Allow-Headers').split(',').map(value=>value.trim().toLowerCase()).includes('x-sunshine-client'));assert.equal(calls.length,0);
});
await test('Custom-domain lookalikes and insecure origins fail before any external call',async()=>{
  for(const origin of ['https://sunshine.bni-pioneer.com.attacker.example','https://sunshine-bni-pioneer.com','https://attacker.sunshine.bni-pioneer.com','http://sunshine.bni-pioneer.com'])for(const method of ['OPTIONS','GET']){const s=setup(),r=await s.call(method,undefined,origin);assert.equal(r.status,403);assert.equal(r.headers.get('Access-Control-Allow-Origin'),null);assert.equal(s.log.length,0);}
});
await test('Explicit ALLOWED_ORIGINS replaces rather than extends the default origins',async()=>{
  const options={allowedOrigins:' https://review.example.test , https://sunshine.bni-pioneer.com '};
  for(const origin of ['https://review.example.test','https://sunshine.bni-pioneer.com']){const s=setup(options),r=await s.call('OPTIONS',undefined,origin);assert.equal(r.status,204);assert.equal(r.headers.get('Access-Control-Allow-Origin'),origin);assert.equal(s.log.length,0);}
  const excluded=setup(options);assert.equal((await excluded.call('GET',undefined,'https://woolim0109.github.io')).status,403);assert.equal(excluded.log.length,0);
  const customExcluded=setup({allowedOrigins:'https://review.example.test'});assert.equal((await customExcluded.call('GET',undefined,'https://sunshine.bni-pioneer.com')).status,403);assert.equal(customExcluded.log.length,0);
});
await test('Expired user token cannot acquire a lease',async()=>{const s=setup({unauthorized:true});assert.equal((await s.call()).status,401);assert.equal(s.log.length,1);});
await test('Expected revision checked before paid call',async()=>{const s=setup();assert.equal((await s.call('POST',{interview_id:interviewId,expected_revision:2})).status,409);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);});
await test('Concurrent analysis stops at database lease',async()=>{const s=setup({busy:true});assert.equal((await s.call()).status,409);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);});
await test('Success is stored as extracted draft only using caller JWT',async()=>{
  const s=setup(),r=await s.call();assert.equal(r.status,200);const saved=await r.json();assert.equal(saved.revision,2);assert.deepEqual(saved.extracted,output);
  const ai=s.log.find(x=>x.path==='/v1/responses');assert.equal(ai.body.model,INTERVIEW_MODEL);assert.equal(ai.body.store,false);assert.equal(ai.body.max_output_tokens,6000);assert.equal(ai.body.reasoning.effort,'low');assert.equal(ai.body.text.format.strict,true);
  assert.equal(ai.body.input[0].content.some(x=>x.type==='input_file'),false);
  const write=s.log.find(x=>x.path.endsWith('/finish_member_interview_review_analysis'));assert.deepEqual(Object.keys(write.body.analysis),['extracted','public_patch','private_patch']);assert.deepEqual(write.body.analysis.public_patch,{});assert.deepEqual(write.body.analysis.private_patch,{});assert.equal(write.headers.Authorization,'Bearer user-jwt');assert.equal(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')),false);
  assert.equal(s.log.filter(x=>x.path==='/rest/v1/members').length,1);
});
await test('PDF bytes are native input_file and retain no Files API upload',async()=>{const pdf='%PDF-1.7\nfixture',s=setup({pdf,document:{mime_type:'application/pdf',raw_text:'',file_size:pdf.length,storage_path:memberId+'/source.pdf'}});assert.equal((await s.call()).status,200);const part=s.log.find(x=>x.path==='/v1/responses').body.input[0].content.find(x=>x.type==='input_file');assert.equal(part.file_data,'data:application/pdf;base64,'+Buffer.from(pdf).toString('base64'));assert.equal(s.log.some(x=>x.path==='/v1/files'),false);});
await test('Invalid storage member path never reaches OpenAI',async()=>{const s=setup({document:{mime_type:'application/pdf',storage_path:'another-member/file.pdf'}});assert.equal((await s.call()).status,400);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));});
await test('Contact and actual customer company are excluded from public suggestions',async()=>{const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('wants',['연락: 010-1234-5678']),suggestion('customer_companies',['비공개상사'],{evidence:'비공개상사'}),suggestion('synergies',['비공개상사 담당자'],{basis:'inferred'})]}});const r=await(await s.call()).json();assert.deepEqual(r.extracted.suggestions.map(x=>x.key),['customers','customer_companies']);assert.equal(r.extracted.warnings.length,2);});
await test('Member-shared referral situations and phrases retain their draft values and storage contract',async()=>{
  const referrals=[suggestion('good_referral',['반복 업무를 자동화하려는 소상공인']),suggestion('triggers',['앱을 만들고 싶은데 개발자를 찾기 힘들다','딱 필요한 기능만 있으면 된다'])],s=setup({output:{...output,suggestions:[...output.suggestions,...referrals]}}),r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();assert.deepEqual(extracted.suggestions.slice(1),referrals);assert.deepEqual(extracted.warnings,[]);
  const ai=s.log.find(x=>x.path==='/v1/responses').body;assert(ai.instructions.includes('승인된 로그인 멤버 전체에게 공유하는 good_referral/triggers'));assert(ai.instructions.includes('관리자와 승인된 본인만 보는 customer_companies'));assert(!ai.instructions.includes('good_referral/triggers/customer_companies는 비공개'));
  const stored=s.log.find(x=>x.path.endsWith('/finish_member_interview_review_analysis')).body.analysis;assert.deepEqual(stored.public_patch,{});assert.deepEqual(stored.private_patch,{});assert.deepEqual(stored.extracted,extracted);
});
await test('Member-shared referral suggestions exclude actual customer companies and private contacts',async()=>{
  for(const key of ['good_referral','triggers'])for(const value of ['비공개상사 소개','연락: 010-1234-5678']){const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('customer_companies',['비공개상사']),suggestion(key,[value])]}}),r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();assert.deepEqual(extracted.suggestions.map(x=>x.key),['customers','customer_companies']);assert.equal(extracted.warnings.length,1);assert(s.diagnostics.some(x=>x.code===(value.includes('010-')?'private_contact':'private_company')));}
});
await test('Incomplete or invalid model output never overwrites draft',async()=>{for(const options of [{aiResponse:{status:'incomplete'}},{output:{...output,suggestions:[{...output.suggestions[0],value:[123]}]}}]){const s=setup(options);assert.equal((await s.call()).status,502);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_review_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));}});
await test('Stale save keeps original and releases lease',async()=>{const s=setup({staleFinish:true});assert.equal((await s.call()).status,409);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));});
await test('Upstream secrets and errors are not returned',async()=>{const s=setup({networkFailure:true}),r=await s.call();assert.equal(r.status,502);assert(!(await r.text()).includes('private'));assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));});
await test('SQLSTATE mapped independently of Korean error text',async()=>{for(const [code,status] of [['40001',409],['55000',409],['22023',400]]){const s=setup({beginError:{code,message:'한국어로 작성된 오류입니다.'}});assert.equal((await s.call()).status,status);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);}});
await test('Overlong AI value omitted without losing other safe draft suggestions',async()=>{const s=setup({output:{...output,suggestions:[suggestion('customers',['가'.repeat(1001),'제조업 대표']),suggestion('field',['기업 컨설팅'])]}});const r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();assert.deepEqual(extracted.suggestions.map(x=>x.value),[['제조업 대표'],['기업 컨설팅']]);assert(extracted.warnings.some(x=>x.includes('1000자')));});
await test('AI HTTP 500 and 429 release lease and never save',async()=>{for(const status of [500,429]){const s=setup({aiStatus:status,aiResponse:{error:{message:'sensitive upstream diagnostics'}}}),r=await s.call();assert.equal(r.status,status===429?429:502);assert(!(await r.text()).includes('sensitive'));assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_review_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));}});
await test('Requested strict schema shares every text/list limit and key-specific cardinality',async()=>{
  const s=setup();await s.call();const schema=s.log.find(x=>x.path==='/v1/responses').body.text.format.schema;
  assert.deepEqual(schema,ANALYSIS_SCHEMA);assert.equal(schema.properties.summary.maxLength,ANALYSIS_LIMITS.summary);assert.equal(schema.properties.detected_name.maxLength,ANALYSIS_LIMITS.name);
  assert.equal(schema.properties.warnings.maxItems,ANALYSIS_LIMITS.warnings);assert.equal(schema.properties.warnings.items.maxLength,ANALYSIS_LIMITS.warning);assert.equal(schema.properties.suggestions.maxItems,7);
  const branches=schema.properties.suggestions.items.anyOf;assert.equal(branches.length,7);assert.equal(new Set(branches.map(x=>x.properties.key.enum[0])).size,7);
  for(const branch of branches){const p=branch.properties,key=p.key.enum[0];assert.equal(branch.additionalProperties,false);assert.deepEqual(branch.required,Object.keys(p));assert.equal(p.value.maxItems,['field','wants','good_referral'].includes(key)?1:30);assert.equal(p.value.items.maxLength,ANALYSIS_LIMITS.value);assert.equal(p.reason.maxLength,ANALYSIS_LIMITS.reason);assert.equal(p.evidence.maxLength,ANALYSIS_LIMITS.evidence);}
});
await test('Team assignments and chapter roles stay outside the model schema and member context',async()=>{
  const s=setup(),r=await s.call();assert.equal(r.status,200);
  const memberRead=s.log.find(x=>x.path==='/rest/v1/members'),columns=new URLSearchParams(memberRead.query).get('select').split(',');
  assert.deepEqual(columns,['id','name','company','field','customers','synergies']);
  const ai=s.log.find(x=>x.path==='/v1/responses').body;
  assert.deepEqual(ai.text.format.schema.properties.suggestions.items.anyOf.map(branch=>branch.properties.key.enum[0]),['field','customers','synergies','wants','good_referral','triggers','customer_companies']);
  const text=ai.input[0].content[0].text,context=JSON.parse(text.slice(text.indexOf('\n')+1));
  assert.deepEqual(Object.keys(context.selected_member),columns);assert.deepEqual(Object.keys(context.chapter_members[0]),columns);
  assert(!text.includes('RETIRED-TEAM-SENTINEL'));assert(!text.includes('OPERATIONS-ROLE-SENTINEL'));
  assert(ai.instructions.includes('협업팀 소속·팀장과 챕터 역할은 운영진이 지정합니다.'));
  assert(ai.instructions.includes('배정 지시를 넣지 마세요.'));assert(!ai.instructions.includes('파워팀'));
});
await test('Retired team and operational-role suggestions cannot be saved even alongside valid suggestions',async()=>{
  for(const key of ['team','chapter_role','collab_teams','leader_member_id']){
    const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion(key,['지정 요청'])]}}),r=await s.call();
    assert.equal(r.status,502);assert.equal((await r.json()).error.code,'invalid_analysis');
    assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_review_analysis')),false);
    assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));
    assert(s.diagnostics.some(x=>x.code==='invalid_key'));
  }
});
await test('Multiple visitor/referral statements join losslessly into reviewed scalar drafts',async()=>{
  const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('wants',['제조업 대표','지역 유통사 대표']),suggestion('good_referral',['공장 이전을 검토하는 기업','신규 판로를 찾는 기업'])]}}),r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();
  assert.deepEqual(extracted.suggestions.find(x=>x.key==='wants').value,['제조업 대표\n지역 유통사 대표']);assert.deepEqual(extracted.suggestions.find(x=>x.key==='good_referral').value,['공장 이전을 검토하는 기업\n신규 판로를 찾는 기업']);assert.equal(extracted.warnings.length,2);assert.equal(s.log.filter(x=>x.path==='/v1/responses').length,1);
});
await test('Conflicting specialty values are omitted rather than selecting the first',async()=>{
  const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('field',['제조','유통'])]}});const {extracted}=await(await s.call()).json();assert.deepEqual(extracted.suggestions.map(x=>x.key),['customers']);assert.equal(extracted.warnings.filter(x=>x.includes('서로 다른 값')).length,1);
  assert.deepEqual(validateAnalysis({...output,suggestions:[suggestion('field',['제조','제조'])]},'홍길동',[interviewId]).suggestions[0].value,['제조']);
});
await test('Duplicate keys omit that entire key and preserve unrelated suggestions',async()=>{
  const s=setup({output:{...output,suggestions:[suggestion('wants',['제조 대표']),suggestion('wants',['유통 대표']),...output.suggestions]}});const {extracted}=await(await s.call()).json();assert.deepEqual(extracted.suggestions.map(x=>x.key),['customers']);assert(extracted.warnings.some(x=>x.includes('중복')));
});
await test('Merged scalar over limit is omitted whole, never silently truncated',async()=>{
  for(const [length,kept] of [[499,true],[500,false]]){const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('good_referral',['가'.repeat(length),'나'.repeat(length)])]}});const {extracted}=await(await s.call()).json();assert.equal(extracted.suggestions.some(x=>x.key==='good_referral'),kept);assert(extracted.suggestions.some(x=>x.key==='customers'));}
});
await test('List overflow and long explanation retain only reviewable bounded items',async()=>{
  const s=setup({output:{...output,suggestions:[suggestion('customers',Array.from({length:31},(_,i)=>'고객 유형 '+i)),suggestion('field',['기업 컨설팅'],{evidence:'나'.repeat(1501)}),suggestion('wants',['제조 대표'],{reason:'가'.repeat(1001)})]}});const {extracted}=await(await s.call()).json();assert.equal(extracted.suggestions.length,1);assert.equal(extracted.suggestions[0].value.length,30);assert(extracted.warnings.some(x=>x.includes('앞의 30개')));assert.equal(extracted.warnings.filter(x=>x.includes('근거가 너무 길어')).length,2);
});
await test('Over-limit summaries and warnings do not discard safe suggestions',async()=>{
  const s=setup({output:{...output,summary:'가'.repeat(5001),detected_name:'나'.repeat(201),warnings:['다'.repeat(1501),...Array.from({length:31},(_,i)=>'주의사항 '+i)]}});const {extracted}=await(await s.call()).json();assert.equal(extracted.summary,'');assert.equal(extracted.detected_name,'');assert.deepEqual(extracted.suggestions,output.suggestions);assert(extracted.warnings.length<=30);assert(extracted.warnings.some(x=>x.includes('요약만 제외')));assert(extracted.warnings.every(x=>Array.from(x).length<=1500));
});
await test('Privacy guards inspect duplicate company entries and over-limit raw tails',async()=>{
  const cases=[
    [suggestion('customer_companies',['첫회사']),suggestion('customer_companies',['비공개상사']),suggestion('wants',['비공개상사 대표'])],
    [suggestion('customer_companies',[...Array.from({length:30},(_,i)=>'테스트 회사 '+i),'비공개상사']),suggestion('wants',['비공개상사 대표'])],
    [suggestion('customer_companies',['비공개상사'],{evidence:'가'.repeat(1501)}),suggestion('wants',['비공개상사 대표'])],
    [suggestion('customers',[...Array.from({length:30},(_,i)=>'고객 유형 '+i),'010-1234-5678']),suggestion('field',['기업 컨설팅'])],
    [suggestion('wants',['제조 대표','문의: secret@example.test']),suggestion('field',['기업 컨설팅'])]
  ];
  for(const suggestions of cases){const s=setup({output:{...output,suggestions}}),r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();assert(!extracted.suggestions.some(x=>x.key==='wants'));assert(!extracted.suggestions.some(x=>x.value.some(v=>v.includes('010-')||v.includes('@'))));assert(s.diagnostics.some(x=>['private_company','private_contact'].includes(x.code)));}
});
await test('Structural errors remain strict even beyond duplicate/array limits',async()=>{
  const malformed=[{...output,suggestions:[...Array.from({length:8},()=>suggestion('field',['기업 컨설팅'])),suggestion('field',[123])]}, {...output,warnings:[false]}, {...output,suggestions:[suggestion('wants',['정상'],{confidence:'certain'})]}, {...output,suggestions:[suggestion('unexpected-private-key',['문장'])]}, {...output,suggestions:[suggestion('wants',['정상'],{extra:'private-text'})]}];
  for(const result of malformed){const s=setup({output:result}),r=await s.call();assert.equal(r.status,502);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_review_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));assert.equal(s.log.filter(x=>x.path==='/v1/responses').length,1);}
});
await test('Diagnostics expose only fixed codes/paths/types/lengths, not content or API credentials',async()=>{
  const s=setup({output:{...output,suggestions:[suggestion('wants',['PRIVATE-CONTENT-SENTINEL','두 번째 문장']),suggestion('field',['기업 컨설팅','생활용품 제조'])]}}),r=await s.call();assert.equal(r.status,200);const body=await r.json();assert(!('diagnostics' in body));assert(s.diagnostics.length>=2);
  for(const diagnostic of s.diagnostics){assert(Object.keys(diagnostic).every(k=>['code','path','type','length'].includes(k)));assert.match(diagnostic.path,/^\$(?:\.(?:summary|detected_name|warnings|suggestions|key|value|reason|evidence|confidence|basis)|\[\d+\])*$/);}
  assert(!JSON.stringify(s.diagnostics).includes('PRIVATE-CONTENT-SENTINEL'));assert(!JSON.stringify(s.diagnostics).includes('private-test-key'));
  const invalid=setup({output:{...output,suggestions:[suggestion('PRIVATE-PROPERTY-SENTINEL',['내용'])]}});await invalid.call();assert(!JSON.stringify(invalid.diagnostics).includes('PRIVATE-PROPERTY-SENTINEL'));
});
await test('Unicode character limits match JSON Schema and PostgreSQL at the boundary',async()=>{
  const result=validateAnalysis({...output,suggestions:[suggestion('customers',['🌞'.repeat(1000),'🌞'.repeat(1001)])]},'홍길동',[interviewId]);assert.deepEqual(result.suggestions[0].value,['🌞'.repeat(1000)]);assert.equal(result.warnings.length,1);
});
await test('Two complementary documents produce one review with both source IDs and all stage headers',async()=>{
  const first=setup().document,second={...first,id:secondId,original_name:'신뢰와 수익 단계.txt',stages:['credibility','profitability'],raw_text:'길동고객사는 신규 공장 설립 때 소개받았습니다.',created_at:'2026-09-22T00:00:00Z'};
  const combined={...output,suggestions:[suggestion('customers',['제조업 대표'],{sources:[interviewId,secondId]}),suggestion('customer_companies',['길동고객사'],{sources:[secondId]})]};
  const s=setup({documents:[second,first],output:combined}),r=await s.call();assert.equal(r.status,200);const saved=await r.json();
  assert.equal(saved.id,reviewId);assert.equal(saved.member_id,memberId);assert.deepEqual(saved.extracted,combined);assert.deepEqual(saved.source_interview_ids,[secondId,interviewId]);
  const requests=s.log.filter(x=>x.path==='/v1/responses');assert.equal(requests.length,1);const ai=requests[0].body;
  const text=ai.input[0].content.filter(p=>p.type==='input_text').map(p=>p.text).join('\n');
  assert(text.includes('[문서: 아는 단계.txt / 단계: 아는 단계]'));assert(text.includes('[문서: 신뢰와 수익 단계.txt / 단계: 신뢰 단계, 수익 단계]'));
  assert(text.includes('문서 ID: '+interviewId));assert(text.includes('문서 ID: '+secondId));assert(text.includes(second.raw_text));assert(text.indexOf(first.raw_text)<text.indexOf(second.raw_text));assert(text.includes('업로드일: '+second.created_at));
  for(const term of ['profile(신상명세표)','visibility(아는 단계/Visibility)','credibility(신뢰 단계/Credibility)','profitability(수익 단계/Profitability)','다른 단계에 있는 명시적 근거','문서에 명시된 작성일','warnings','하나로 합치고','sources'])assert(ai.instructions.includes(term),term);
  const begin=s.log.find(x=>x.path.endsWith('/begin_member_interview_review_analysis'));assert.deepEqual(begin.body,{target_interview_ids:[secondId,interviewId]});
  const finish=s.log.find(x=>x.path.endsWith('/finish_member_interview_review_analysis'));assert.equal(finish.body.target_review_id,reviewId);assert.equal(finish.body.expected_revision,1);assert.equal(finish.body.lease_id,leaseId);
});
await test('A third document can be analyzed with applied sources and retains current member context',async()=>{
  const first={...setup().document,status:'applied'},second={...first,id:secondId,original_name:'신뢰 단계.txt',stages:['credibility'],raw_text:'제조업 대표가 주요 고객입니다.'},third={...first,id:thirdId,status:'uploaded',original_name:'새 수익 단계.txt',stages:['profitability'],created_at:'2026-09-23T00:00:00Z',raw_text:'유통업 대표도 소개받고 싶습니다.'};
  const result={...output,suggestions:[suggestion('customers',['제조업 대표','유통업 대표'],{sources:[interviewId,secondId,thirdId]})]};
  const s=setup({documents:[first,second,third],currentCustomers:['제조업 대표'],output:result}),r=await s.call();assert.equal(r.status,200);const saved=await r.json();assert.deepEqual(saved.extracted.suggestions[0].value,['제조업 대표','유통업 대표']);assert.deepEqual(saved.extracted.suggestions[0].sources,[interviewId,secondId,thirdId]);
  const ai=s.log.find(x=>x.path==='/v1/responses').body,context=ai.input[0].content[0].text;assert(context.includes('"customers":["제조업 대표"]'));assert(ai.instructions.includes('기존 값 삭제를 제안하지 마세요.'));
  assert.deepEqual(saved.public_patch,{});assert.deepEqual(saved.private_patch,{});assert.equal(s.log.filter(x=>x.path==='/v1/responses').length,1);assert(s.log.every(x=>x.path!=='/rest/v1/members'||x.body===null));
});
await test('Legacy single-document requests create integrated reviews including applied documents',async()=>{
  const s=setup({document:{status:'applied'}}),r=await s.call('POST',{interview_id:interviewId,expected_revision:1});assert.equal(r.status,200);assert.equal((await r.json()).id,reviewId);assert(s.log.some(x=>x.path.endsWith('/begin_member_interview_review_analysis')));assert(s.log.every(x=>!x.path.endsWith('/get_member_interview')));
});
await test('Selection validation rejects missing, duplicate, malformed, ambiguous, and over-limit IDs before acquiring a lease',async()=>{
  const ids=Array.from({length:21},(_,i)=>'cccccccc-cccc-4ccc-8ccc-'+i.toString(16).padStart(12,'0'));
  for(const data of [{},{interview_ids:[]},{interview_ids:'not-an-array'},{interview_ids:[interviewId,interviewId.toUpperCase()]},{interview_ids:[null]},{interview_ids:['not-a-uuid']},{interview_ids:ids},{interview_ids:[interviewId],interview_id:interviewId}]){const s=setup(),r=await s.call('POST',data);assert.equal(r.status,400);assert.equal(s.log.some(x=>x.path.includes('/rpc/')||x.path==='/v1/responses'),false);}
});
await test('Mixed-member selections rejected by the database never reach the model',async()=>{
  const s=setup({beginError:{code:'22023',message:'mixed_member_documents'}}),r=await s.call('POST',{interview_ids:[interviewId,secondId]});assert.equal(r.status,400);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_review_analysis')),false);
});
await test('Database document snapshots must exactly match requested IDs and the review member',async()=>{
  const doc=setup().document;
  for(const documents of [[{...doc,member_id:userId}],[{...doc,id:secondId}],[doc,{...doc}],[{...doc,stages:['invalid']}],[{...doc,stages:['profile','profile']}],[{...doc,original_name:''}],[{...doc,created_at:'yesterday'}]]){const s=setup({documents}),r=await s.call('POST',{interview_ids:[interviewId]});assert.equal(r.status,502);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));}
});
await test('Every proposal requires nonempty unique sources from the selection and rejects invented document IDs',async()=>{
  for(const sources of [undefined,[],[secondId],['not-a-uuid'],[123],[interviewId,interviewId],[interviewId,...Array.from({length:20},()=>interviewId)]]){const proposal=suggestion('customers',['제조업 대표'],{sources});if(sources===undefined)delete proposal.sources;const s=setup({output:{...output,suggestions:[proposal]}}),r=await s.call();assert.equal(r.status,502);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_review_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));assert(!JSON.stringify(s.diagnostics).includes(secondId));}
  const normalized=validateAnalysis({...output,suggestions:[suggestion('customers',['제조업 대표'],{sources:[interviewId.toUpperCase()]})]},'홍길동',[interviewId]);assert.deepEqual(normalized.suggestions[0].sources,[interviewId]);
});
await test('Strict structured output requires source arrays bounded to the selected document maximum',async()=>{
  for(const branch of ANALYSIS_SCHEMA.properties.suggestions.items.anyOf){assert(branch.required.includes('sources'));assert.equal(branch.properties.sources.minItems,1);assert.equal(branch.properties.sources.maxItems,DOCUMENT_LIMITS.count);assert(branch.properties.sources.items.pattern);}
});
await test('Original file and aggregate raw-text limits fail before a paid request and release the review lease',async()=>{
  const doc=setup().document,make=(id,extra)=>({...doc,id,...extra});
  const cases=[
    [make(interviewId,{raw_text:'가'.repeat(120001)})],
    [make(interviewId,{raw_text:'가'.repeat(120000)}),make(secondId,{raw_text:'나'.repeat(120000)}),make(thirdId,{raw_text:'다'})],
    [make(interviewId,{file_size:DOCUMENT_LIMITS.fileBytes+1})],
    [make(interviewId,{file_size:DOCUMENT_LIMITS.fileBytes}),make(secondId,{file_size:DOCUMENT_LIMITS.fileBytes}),make(thirdId,{file_size:1})]
  ];
  for(const documents of cases){const s=setup({documents}),r=await s.call();assert.equal(r.status,413);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_review_analysis')));}
  const boundary=setup({documents:[make(interviewId,{raw_text:'가'.repeat(120000),file_size:DOCUMENT_LIMITS.fileBytes}),make(secondId,{raw_text:'나'.repeat(120000),file_size:DOCUMENT_LIMITS.fileBytes})]});assert.equal((await boundary.call()).status,200);
});
await test('Mixed native PDF and text inputs keep distinct document IDs and headers in a single model call',async()=>{
  const pdf='%PDF-1.7\nfixture',first=setup().document,second={...first,id:secondId,original_name:'신상명세표.pdf',stages:['profile'],mime_type:'application/pdf',raw_text:'',file_size:pdf.length,storage_path:memberId+'/profile.pdf'};
  const s=setup({documents:[first,second],pdf,output:{...output,suggestions:[suggestion('customers',['제조업 대표'],{sources:[interviewId,secondId]})]}}),r=await s.call();assert.equal(r.status,200);
  const calls=s.log.filter(x=>x.path==='/v1/responses');assert.equal(calls.length,1);const content=calls[0].body.input[0].content,fileIndex=content.findIndex(x=>x.type==='input_file');assert(content[fileIndex-1].text.includes('[문서: 신상명세표.pdf / 단계: 신상명세표]'));assert(content[fileIndex-1].text.includes(secondId));assert.equal(content[fileIndex].filename,'interview-'+secondId+'.pdf');
});
console.log(count+' isolated Edge tests passed; no network used.');
