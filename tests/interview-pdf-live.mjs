// Explicit, one-shot paid integration check. Auth/DB/Storage stay in memory;
// only the production OpenAI Responses request leaves this process.
// Export fixture-text.json with INTERVIEW_EXTRACTION_OUTPUT=diagnostics-output/interview-pdf-high/fixture-text.json
// when running node tests/interview-extraction.mjs.
// Run with OPENAI_API_KEY set: node --experimental-strip-types tests/interview-pdf-live.mjs --run-once
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHandler,INTERVIEW_MODEL} from '../supabase/functions/analyze-interview/index.ts';

if(!process.argv.includes('--run-once'))throw Error('Pass --run-once to authorize exactly one paid Responses request.');
if(!process.env.OPENAI_API_KEY)throw Error('OPENAI_API_KEY must be available locally. No API request was made.');
const root=fileURLToPath(new URL('../',import.meta.url));
const outputDir=path.join(root,'diagnostics-output/interview-pdf-high');
for(const name of ['live-attempt.json','live-openai-response.json','live-result.json']){
  const exists=await access(path.join(outputDir,name)).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;});
  if(exists)throw Error('A previous live run is recorded. No request was made and its results were preserved.');
}
const fixtureDir=process.env.INTERVIEW_FIXTURES_DIR||path.join(root,'121자료집');
const extracted=JSON.parse(await readFile(path.join(outputDir,'fixture-text.json'),'utf8'));
const memberId='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const leaseId='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const reviewId='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const fixtureNames=['121미팅플래너_신상명세표_아는단계_김경태_20260928.pdf','121미팅플래너_신뢰단계_김경태_20260928.pdf'];
const documents=[],pdfBytes=new Map(),fixtureSummary=[];
for(const [index,name] of fixtureNames.entries()){
  const bytes=await readFile(path.join(fixtureDir,name)),text=extracted[name];
  assert(bytes.subarray(0,5).equals(Buffer.from('%PDF-')),'Expected a genuine local PDF.');
  assert(text&&typeof text.raw_text==='string'&&text.raw_text.length>0,'Export production pdf.js fixture text first.');
  assert.equal(text.source_sha256,createHash('sha256').update(bytes).digest('hex'),'The extracted text must belong to this exact PDF. Run the fixture export again.');
  const id=index===0?'cccccccc-cccc-4ccc-8ccc-cccccccccccc':'cccccccc-cccc-4ccc-8ccc-cccccccccccd';
  const storagePath=memberId+'/'+id+'.pdf';
  documents.push({id,member_id:memberId,revision:1,raw_text:text.raw_text,original_name:name,stages:index===0?['profile','visibility']:['profile','credibility'],created_at:`2026-09-28T0${index}:00:00Z`,mime_type:'application/pdf',storage_path:storagePath,file_size:bytes.length});
  pdfBytes.set('/storage/v1/object/authenticated/member-interviews/'+storagePath,bytes);
  fixtureSummary.push({name,bytes:bytes.length,pages:text.pageCount,text_characters:Array.from(text.raw_text).length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await mkdir(outputDir,{recursive:true});
const edgeSha256=createHash('sha256').update(await readFile(path.join(root,'supabase/functions/analyze-interview/index.ts'))).digest('hex');
const review={id:reviewId,member_id:memberId,revision:1,status:'analyzing',source_interview_ids:documents.map(d=>d.id)};
const respond=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
let calls=0,finished=null,requestSummary=null,upstreamStatus=null,usage=null;
const transport=async(url,init={})=>{
  const parsed=new URL(url),body=init.body?JSON.parse(init.body):null;
  if(parsed.origin==='https://api.openai.com'){
    assert.equal(parsed.pathname,'/v1/responses');
    assert.equal(init.method,'POST');assert.equal(calls,0,'A second paid request is forbidden.');
    assert.equal(body.model,INTERVIEW_MODEL);assert.equal(body.store,false);
    const inputs=body.input.flatMap(item=>item.content),files=inputs.filter(item=>item.type==='input_file');
    assert.equal(files.length,2);assert(files.every(file=>file.detail==='high'));
    assert(!inputs.some(item=>item.type==='input_image'),'This task sends native PDFs only.');
    const received=files.map(file=>createHash('sha256').update(Buffer.from(file.file_data.split(',')[1],'base64')).digest('hex')).sort();
    assert.deepEqual(received,fixtureSummary.map(file=>file.sha256).sort());
    requestSummary={model:body.model,store:body.store,pdf_count:files.length,detail:files.map(file=>file.detail),max_output_tokens:body.max_output_tokens};
    // Durable guard: an interrupted process must not silently repeat a paid run.
    await writeFile(path.join(outputDir,'live-attempt.json'),JSON.stringify({started_at:new Date().toISOString(),edgeSha256,fixtures:fixtureSummary,request:requestSummary},null,2),{flag:'wx'});
    calls++;
    const response=await fetch(url,init);upstreamStatus=response.status;
    const payload=await response.clone().json();
    usage=payload.usage||null;
    await writeFile(path.join(outputDir,'live-openai-response.json'),JSON.stringify(payload,null,2));
    return response;
  }
  assert.equal(parsed.origin,'https://interview-validation.invalid','Unexpected external destination.');
  if(parsed.pathname==='/auth/v1/user')return respond({id:userId,email:'admin@example.test',email_confirmed_at:'2026-09-28T00:00:00Z',is_anonymous:false});
  if(parsed.pathname==='/rest/v1/member_accounts')return respond([{role:'admin'}]);
  if(parsed.pathname==='/rest/v1/rpc/list_member_interviews')return respond(documents.map(({raw_text,storage_path,...metadata})=>metadata));
  if(parsed.pathname==='/rest/v1/rpc/begin_member_interview_review_analysis'){
    assert.deepEqual([...body.target_interview_ids].sort(),documents.map(d=>d.id).sort());
    return respond({lease_id:leaseId,expires_at:new Date(Date.now()+180000).toISOString(),review,documents});
  }
  if(parsed.pathname==='/rest/v1/members')return respond([{id:memberId,name:'김경태',company:'',field:'',customers:[],synergies:[]}]);
  if(pdfBytes.has(parsed.pathname))return new Response(pdfBytes.get(parsed.pathname),{headers:{'Content-Type':'application/pdf'}});
  if(parsed.pathname==='/rest/v1/rpc/finish_member_interview_review_analysis'){
    finished={...review,revision:2,status:'draft',...body.analysis};return respond(finished);
  }
  if(parsed.pathname==='/rest/v1/rpc/cancel_member_interview_review_analysis')return respond({released:true});
  throw Error('Unexpected mocked route: '+parsed.pathname);
};
const env={SUPABASE_URL:'https://interview-validation.invalid',SUPABASE_ANON_KEY:'public-test-key',OPENAI_API_KEY:process.env.OPENAI_API_KEY};
const handler=createHandler({env:key=>env[key],fetch:transport});
const response=await handler(new Request('https://interview-validation.invalid/functions/v1/analyze-interview',{method:'POST',headers:{Origin:'https://woolim0109.github.io',Authorization:'Bearer local-test-admin','Content-Type':'application/json'},body:JSON.stringify({interview_ids:documents.map(d=>d.id)})}));
const result=await response.json();
if(calls===0)throw Error('No OpenAI request was made (local handler status '+response.status+'). Existing results were preserved.');
const suggestions=result.extracted?.suggestions||[];
const discount=suggestions.filter(s=>/카드|제휴/.test(s.value.join(' '))&&/할인/.test(s.value.join(' '))&&/월\s*(?:5\s*천|5,?000)\s*원/.test(s.value.join(' ')));
const petOwners=suggestions.filter(s=>/동물병원/.test(s.value.join(' '))&&/(?:펫|팻)\s*(?:관련\s*)?(?:샵|숍|샾)|반려동물\s*(?:관련\s*)?(?:샵|숍|매장)/.test(s.value.join(' '))&&/(?:점주|업주|운영자|대표)/.test(s.value.join(' ')));
// Page evidence is reported separately: the concepts also occur in extracted
// text, so the presence of the target words alone cannot prove image reading.
const imageEvidence={discount:discount.map(s=>({key:s.key,sources:s.sources,evidence:s.evidence,expected_image_pages:{[documents[0].id]:[13],[documents[1].id]:[4,5]}})),pet_owners:petOwners.map(s=>({key:s.key,sources:s.sources,evidence:s.evidence,expected_image_pages:{[documents[1].id]:[7]}}))};
const report={completed_at:new Date().toISOString(),edge_sha256:edgeSha256,ai_calls:calls,http_status:response.status,upstream_status:upstreamStatus,request:requestSummary,usage,fixtures:fixtureSummary,checks:{mentions_card_discount_and_monthly_5000:discount.length>0,mentions_animal_hospital_and_pet_shop_owners:petOwners.length>0,source_documents_valid:suggestions.every(s=>s.sources.length>0&&s.sources.every(id=>documents.some(d=>d.id===id))),meaning_and_image_page_evidence_require_manual_review:true,db_writes:0},matching_suggestions:{discount,pet_owners:petOwners},image_evidence:imageEvidence,result};
await writeFile(path.join(outputDir,'live-result.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify({ai_calls:calls,http_status:response.status,upstream_status:upstreamStatus,checks:report.checks,result_file:path.join(outputDir,'live-result.json')},null,2));
assert.equal(calls,1);assert.equal(response.status,200,'Read the local result; do not automatically retry.');assert(finished);
assert(report.checks.mentions_card_discount_and_monthly_5000,'Card discount and monthly 5,000 KRW were not found in proposals.');
assert(report.checks.mentions_animal_hospital_and_pet_shop_owners,'Animal hospital/pet shop owners were not found in proposals.');
assert(report.checks.source_documents_valid);
