// No network: every Auth, REST, Storage, and OpenAI call uses the test transport.
// Run: node --experimental-strip-types tests/interview-edge.mjs
import assert from 'node:assert/strict';
import {createHandler,INTERVIEW_MODEL,ANALYSIS_SCHEMA,ANALYSIS_LIMITS,validateAnalysis} from '../supabase/functions/analyze-interview/index.ts';
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',memberId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',interviewId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',leaseId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const output={summary:'인터뷰 요약',detected_name:'홍길동',warnings:[],suggestions:[{key:'customers',value:['제조업 대표'],reason:'사업 분야',evidence:'제조업 대표가 주요 고객입니다.',confidence:'high',basis:'stated'}]};
const suggestion=(key,value,extra={})=>({...output.suggestions[0],key,value,...extra});
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
function setup(options={}){
  const log=[],document={id:interviewId,member_id:memberId,revision:1,raw_text:'제조업 대표가 주요 고객입니다.',mime_type:'text/plain',storage_path:memberId+'/source.txt',file_size:100,...options.document};
  const fetch=async(url,init={})=>{
    const parsed=new URL(url),body=init.body?JSON.parse(init.body):null;
    log.push({path:parsed.pathname,query:parsed.search,body,headers:init.headers});
    if(parsed.pathname==='/auth/v1/user')return response(options.unauthorized?{}:{id:userId,email:'admin@example.test',email_confirmed_at:'2026-09-21T00:00:00Z',is_anonymous:false},options.unauthorized?401:200);
    if(parsed.pathname==='/rest/v1/member_accounts')return response([{role:options.role||'admin'}]);
    if(parsed.pathname==='/rest/v1/rpc/get_member_interview')return response(document);
    if(parsed.pathname==='/rest/v1/rpc/begin_member_interview_analysis')return options.beginError?response(options.beginError,400):options.busy?response({message:'analysis_in_progress'},409):response({lease_id:leaseId,expires_at:'2026-09-21T00:03:00Z',interview:document});
    if(parsed.pathname==='/rest/v1/members')return response([{id:memberId,name:'홍길동',company:'길동상사',field:'제조',team:'기업',customers:[],synergies:[]}]);
    if(parsed.pathname.startsWith('/storage/v1/object/authenticated/'))return new Response(options.pdf||'%PDF-1.7\nfixture');
    if(parsed.pathname==='/v1/responses'){
      if(options.networkFailure)throw new Error('private-upstream-error');
      return response(options.aiResponse||{status:'completed',output:[{type:'message',content:[{type:'output_text',text:JSON.stringify(options.output||output)}]}]},options.aiStatus||200);
    }
    if(parsed.pathname==='/rest/v1/rpc/finish_member_interview_analysis')return options.staleFinish?response({message:'stale_revision'},409):response({...document,revision:2,extracted:body.analysis_patch.extracted});
    if(parsed.pathname==='/rest/v1/rpc/cancel_member_interview_analysis')return response({released:true});
    throw Error('Unexpected external call '+url);
  };
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-test-key',OPENAI_API_KEY:options.noKey?'':'private-test-key',...(options.allowedOrigins===undefined?{}:{ALLOWED_ORIGINS:options.allowedOrigins})};
  const diagnostics=[];
  const handler=createHandler({fetch,env:key=>env[key],diagnostic:entry=>diagnostics.push(entry)});
  const call=(method='POST',data={interview_id:interviewId,expected_revision:1},origin='https://woolim0109.github.io')=>handler(new Request('https://example.supabase.co/functions/v1/analyze-interview',{method,headers:{Origin:origin,Authorization:'Bearer user-jwt','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(data)}:{})}));
  return {log,call,diagnostics};
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
  const write=s.log.find(x=>x.path.endsWith('/finish_member_interview_analysis'));assert.deepEqual(Object.keys(write.body.analysis_patch),['extracted','public_patch','private_patch']);assert.deepEqual(write.body.analysis_patch.public_patch,{});assert.deepEqual(write.body.analysis_patch.private_patch,{});assert.equal(write.headers.Authorization,'Bearer user-jwt');assert.equal(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')),false);
  assert.equal(s.log.filter(x=>x.path==='/rest/v1/members').length,1);
});
await test('PDF bytes are native input_file and retain no Files API upload',async()=>{const pdf='%PDF-1.7\nfixture',s=setup({pdf,document:{mime_type:'application/pdf',raw_text:'',file_size:pdf.length,storage_path:memberId+'/source.pdf'}});assert.equal((await s.call()).status,200);const part=s.log.find(x=>x.path==='/v1/responses').body.input[0].content.find(x=>x.type==='input_file');assert.equal(part.file_data,'data:application/pdf;base64,'+Buffer.from(pdf).toString('base64'));assert.equal(s.log.some(x=>x.path==='/v1/files'),false);});
await test('Invalid storage member path never reaches OpenAI',async()=>{const s=setup({document:{mime_type:'application/pdf',storage_path:'another-member/file.pdf'}});assert.equal((await s.call()).status,400);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));});
await test('Contact and actual customer company are excluded from public suggestions',async()=>{const s=setup({output:{...output,suggestions:[...output.suggestions,{key:'wants',value:['연락: 010-1234-5678'],reason:'',evidence:'',confidence:'high',basis:'stated'},{key:'customer_companies',value:['비공개상사'],reason:'',evidence:'비공개상사',confidence:'high',basis:'stated'},{key:'synergies',value:['비공개상사 담당자'],reason:'',evidence:'',confidence:'low',basis:'inferred'}]}});const r=await(await s.call()).json();assert.deepEqual(r.extracted.suggestions.map(x=>x.key),['customers','customer_companies']);assert.equal(r.extracted.warnings.length,2);});
await test('Incomplete or invalid model output never overwrites draft',async()=>{for(const options of [{aiResponse:{status:'incomplete'}},{output:{...output,suggestions:[{...output.suggestions[0],value:[123]}]}}]){const s=setup(options);assert.equal((await s.call()).status,502);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));}});
await test('Stale save keeps original and releases lease',async()=>{const s=setup({staleFinish:true});assert.equal((await s.call()).status,409);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));});
await test('Upstream secrets and errors are not returned',async()=>{const s=setup({networkFailure:true}),r=await s.call();assert.equal(r.status,502);assert(!(await r.text()).includes('private'));assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));});
await test('SQLSTATE mapped independently of Korean error text',async()=>{for(const [code,status] of [['40001',409],['55000',409],['22023',400]]){const s=setup({beginError:{code,message:'한국어로 작성된 오류입니다.'}});assert.equal((await s.call()).status,status);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);}});
await test('Overlong AI value omitted without losing other safe draft suggestions',async()=>{const s=setup({output:{...output,suggestions:[suggestion('customers',['가'.repeat(1001),'제조업 대표']),suggestion('team',['기업'])]}});const r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();assert.deepEqual(extracted.suggestions.map(x=>x.value),[['제조업 대표'],['기업']]);assert(extracted.warnings.some(x=>x.includes('1000자')));});
await test('AI HTTP 500 and 429 release lease and never save',async()=>{for(const status of [500,429]){const s=setup({aiStatus:status,aiResponse:{error:{message:'sensitive upstream diagnostics'}}}),r=await s.call();assert.equal(r.status,status===429?429:502);assert(!(await r.text()).includes('sensitive'));assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));}});
await test('Requested strict schema shares every text/list limit and key-specific cardinality',async()=>{
  const s=setup();await s.call();const schema=s.log.find(x=>x.path==='/v1/responses').body.text.format.schema;
  assert.deepEqual(schema,ANALYSIS_SCHEMA);assert.equal(schema.properties.summary.maxLength,ANALYSIS_LIMITS.summary);assert.equal(schema.properties.detected_name.maxLength,ANALYSIS_LIMITS.name);
  assert.equal(schema.properties.warnings.maxItems,ANALYSIS_LIMITS.warnings);assert.equal(schema.properties.warnings.items.maxLength,ANALYSIS_LIMITS.warning);assert.equal(schema.properties.suggestions.maxItems,8);
  const branches=schema.properties.suggestions.items.anyOf;assert.equal(branches.length,8);assert.equal(new Set(branches.map(x=>x.properties.key.enum[0])).size,8);
  for(const branch of branches){const p=branch.properties,key=p.key.enum[0];assert.equal(branch.additionalProperties,false);assert.deepEqual(branch.required,Object.keys(p));assert.equal(p.value.maxItems,['field','team','wants','good_referral'].includes(key)?1:30);assert.equal(p.value.items.maxLength,ANALYSIS_LIMITS.value);assert.equal(p.reason.maxLength,ANALYSIS_LIMITS.reason);assert.equal(p.evidence.maxLength,ANALYSIS_LIMITS.evidence);}
});
await test('Multiple visitor/referral statements join losslessly into reviewed scalar drafts',async()=>{
  const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('wants',['제조업 대표','지역 유통사 대표']),suggestion('good_referral',['공장 이전을 검토하는 기업','신규 판로를 찾는 기업'])]}}),r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();
  assert.deepEqual(extracted.suggestions.find(x=>x.key==='wants').value,['제조업 대표\n지역 유통사 대표']);assert.deepEqual(extracted.suggestions.find(x=>x.key==='good_referral').value,['공장 이전을 검토하는 기업\n신규 판로를 찾는 기업']);assert.equal(extracted.warnings.length,2);assert.equal(s.log.filter(x=>x.path==='/v1/responses').length,1);
});
await test('Conflicting field/team values are omitted rather than selecting the first',async()=>{
  const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('field',['제조','유통']),suggestion('team',['기업','생활'])]}});const {extracted}=await(await s.call()).json();assert.deepEqual(extracted.suggestions.map(x=>x.key),['customers']);assert.equal(extracted.warnings.filter(x=>x.includes('서로 다른 값')).length,2);
  assert.deepEqual(validateAnalysis({...output,suggestions:[suggestion('team',['기업','기업'])]},'홍길동').suggestions[0].value,['기업']);
});
await test('Duplicate keys omit that entire key and preserve unrelated suggestions',async()=>{
  const s=setup({output:{...output,suggestions:[suggestion('wants',['제조 대표']),suggestion('wants',['유통 대표']),...output.suggestions]}});const {extracted}=await(await s.call()).json();assert.deepEqual(extracted.suggestions.map(x=>x.key),['customers']);assert(extracted.warnings.some(x=>x.includes('중복')));
});
await test('Merged scalar over limit is omitted whole, never silently truncated',async()=>{
  for(const [length,kept] of [[499,true],[500,false]]){const s=setup({output:{...output,suggestions:[...output.suggestions,suggestion('good_referral',['가'.repeat(length),'나'.repeat(length)])]}});const {extracted}=await(await s.call()).json();assert.equal(extracted.suggestions.some(x=>x.key==='good_referral'),kept);assert(extracted.suggestions.some(x=>x.key==='customers'));}
});
await test('List overflow and long explanation retain only reviewable bounded items',async()=>{
  const s=setup({output:{...output,suggestions:[suggestion('customers',Array.from({length:31},(_,i)=>'고객 유형 '+i)),suggestion('team',['기업'],{evidence:'나'.repeat(1501)}),suggestion('wants',['제조 대표'],{reason:'가'.repeat(1001)})]}});const {extracted}=await(await s.call()).json();assert.equal(extracted.suggestions.length,1);assert.equal(extracted.suggestions[0].value.length,30);assert(extracted.warnings.some(x=>x.includes('앞의 30개')));assert.equal(extracted.warnings.filter(x=>x.includes('근거가 너무 길어')).length,2);
});
await test('Over-limit summaries and warnings do not discard safe suggestions',async()=>{
  const s=setup({output:{...output,summary:'가'.repeat(5001),detected_name:'나'.repeat(201),warnings:['다'.repeat(1501),...Array.from({length:31},(_,i)=>'주의사항 '+i)]}});const {extracted}=await(await s.call()).json();assert.equal(extracted.summary,'');assert.equal(extracted.detected_name,'');assert.deepEqual(extracted.suggestions,output.suggestions);assert(extracted.warnings.length<=30);assert(extracted.warnings.some(x=>x.includes('요약만 제외')));assert(extracted.warnings.every(x=>Array.from(x).length<=1500));
});
await test('Privacy guards inspect duplicate company entries and over-limit raw tails',async()=>{
  const cases=[
    [suggestion('customer_companies',['첫회사']),suggestion('customer_companies',['비공개상사']),suggestion('wants',['비공개상사 대표'])],
    [suggestion('customer_companies',[...Array.from({length:30},(_,i)=>'테스트 회사 '+i),'비공개상사']),suggestion('wants',['비공개상사 대표'])],
    [suggestion('customer_companies',['비공개상사'],{evidence:'가'.repeat(1501)}),suggestion('wants',['비공개상사 대표'])],
    [suggestion('customers',[...Array.from({length:30},(_,i)=>'고객 유형 '+i),'010-1234-5678']),suggestion('team',['기업'])],
    [suggestion('wants',['제조 대표','문의: secret@example.test']),suggestion('team',['기업'])]
  ];
  for(const suggestions of cases){const s=setup({output:{...output,suggestions}}),r=await s.call();assert.equal(r.status,200);const {extracted}=await r.json();assert(!extracted.suggestions.some(x=>x.key==='wants'));assert(!extracted.suggestions.some(x=>x.value.some(v=>v.includes('010-')||v.includes('@'))));assert(s.diagnostics.some(x=>['private_company','private_contact'].includes(x.code)));}
});
await test('Structural errors remain strict even beyond duplicate/array limits',async()=>{
  const malformed=[{...output,suggestions:[...Array.from({length:8},()=>suggestion('team',['기업'])),suggestion('team',[123])]}, {...output,warnings:[false]}, {...output,suggestions:[suggestion('wants',['정상'],{confidence:'certain'})]}, {...output,suggestions:[suggestion('unexpected-private-key',['문장'])]}, {...output,suggestions:[suggestion('wants',['정상'],{extra:'private-text'})]}];
  for(const result of malformed){const s=setup({output:result}),r=await s.call();assert.equal(r.status,502);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));assert.equal(s.log.filter(x=>x.path==='/v1/responses').length,1);}
});
await test('Diagnostics expose only fixed codes/paths/types/lengths, not content or API credentials',async()=>{
  const s=setup({output:{...output,suggestions:[suggestion('wants',['PRIVATE-CONTENT-SENTINEL','두 번째 문장']),suggestion('team',['기업','생활'])]}}),r=await s.call();assert.equal(r.status,200);const body=await r.json();assert(!('diagnostics' in body));assert(s.diagnostics.length>=2);
  for(const diagnostic of s.diagnostics){assert(Object.keys(diagnostic).every(k=>['code','path','type','length'].includes(k)));assert.match(diagnostic.path,/^\$(?:\.(?:summary|detected_name|warnings|suggestions|key|value|reason|evidence|confidence|basis)|\[\d+\])*$/);}
  assert(!JSON.stringify(s.diagnostics).includes('PRIVATE-CONTENT-SENTINEL'));assert(!JSON.stringify(s.diagnostics).includes('private-test-key'));
  const invalid=setup({output:{...output,suggestions:[suggestion('PRIVATE-PROPERTY-SENTINEL',['내용'])]}});await invalid.call();assert(!JSON.stringify(invalid.diagnostics).includes('PRIVATE-PROPERTY-SENTINEL'));
});
await test('Unicode character limits match JSON Schema and PostgreSQL at the boundary',async()=>{
  const result=validateAnalysis({...output,suggestions:[suggestion('customers',['🌞'.repeat(1000),'🌞'.repeat(1001)])]},'홍길동');assert.deepEqual(result.suggestions[0].value,['🌞'.repeat(1000)]);assert.equal(result.warnings.length,1);
});
console.log(count+' isolated Edge tests passed; no network used.');
