// No network: every Auth, REST, Storage, and OpenAI call uses the test transport.
// Run: node --experimental-strip-types tests/interview-edge.mjs
import assert from 'node:assert/strict';
import {createHandler,INTERVIEW_MODEL} from '../supabase/functions/analyze-interview/index.ts';
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',memberId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',interviewId='cccccccc-cccc-4ccc-8ccc-cccccccccccc',leaseId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const output={summary:'인터뷰 요약',detected_name:'홍길동',warnings:[],suggestions:[{key:'customers',value:['제조업 대표'],reason:'사업 분야',evidence:'제조업 대표가 주요 고객입니다.',confidence:'high',basis:'stated'}]};
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
  const env={SUPABASE_URL:'https://example.supabase.co',SUPABASE_ANON_KEY:'public-test-key',OPENAI_API_KEY:options.noKey?'':'private-test-key'};
  const handler=createHandler({fetch,env:key=>env[key]});
  const call=(method='POST',data={interview_id:interviewId,expected_revision:1},origin='https://woolim0109.github.io')=>handler(new Request('https://example.supabase.co/functions/v1/analyze-interview',{method,headers:{Origin:origin,Authorization:'Bearer user-jwt','Content-Type':'application/json'},...(method==='POST'?{body:JSON.stringify(data)}:{})}));
  return {log,call};
}
let count=0;
async function test(name,fn){await fn();count++;console.log('PASS '+name);}
await test('GET configuration still requires admin',async()=>{const s=setup({role:'member'});assert.equal((await s.call('GET')).status,403);assert.equal(s.log.some(x=>x.path==='/v1/responses'),false);});
await test('GET missing key reports false without model call',async()=>{const s=setup({noKey:true});assert.deepEqual(await(await s.call('GET')).json(),{configured:false});assert.equal(s.log.length,2);});
await test('Disallowed origin rejects before reading auth or original',async()=>{const s=setup();assert.equal((await s.call('GET',undefined,'https://untrusted.example')).status,403);assert.equal(s.log.length,0);});
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
await test('1001-character AI value rejected before SQL storage',async()=>{const s=setup({output:{...output,suggestions:[{...output.suggestions[0],value:['가'.repeat(1001)]}]}});assert.equal((await s.call()).status,502);assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_analysis')),false);});
await test('AI HTTP 500 and 429 release lease and never save',async()=>{for(const status of [500,429]){const s=setup({aiStatus:status,aiResponse:{error:{message:'sensitive upstream diagnostics'}}}),r=await s.call();assert.equal(r.status,status===429?429:502);assert(!(await r.text()).includes('sensitive'));assert.equal(s.log.some(x=>x.path.endsWith('/finish_member_interview_analysis')),false);assert(s.log.some(x=>x.path.endsWith('/cancel_member_interview_analysis')));}});
console.log(count+' isolated Edge tests passed; no network used.');
