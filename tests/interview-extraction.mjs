// Synthetic parser fixtures and local 121 stage-tag fixtures. Never uploads a file.
// Run: node tests/interview-extraction.mjs
// Optional: INTERVIEW_FIXTURES_DIR points to the four private PDFs; absent local fixtures are skipped.
// Optional: INTERVIEW_EXTRACTION_OUTPUT saves the local Kim fixture text to JSON without printing it.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFile,readdir,mkdir,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import http from 'node:http';
const require=createRequire(import.meta.url),candidates=['playwright','playwright-core'];
try{for(const file of await readdir(path.join(homedir(),'AppData/Local/ms-playwright/.links')))candidates.push((await readFile(path.join(homedir(),'AppData/Local/ms-playwright/.links',file),'utf8')).trim());}catch{}
let playwright;for(const candidate of candidates){try{playwright=require(candidate);break;}catch{}}
if(!playwright)throw Error('Existing Playwright installation required.');
function pdf(content){
  const stream=content?'BT /F1 14 Tf 40 760 Td (Interview question: core customers) Tj ET':'';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let text='%PDF-1.4\n',offsets=[0];objects.forEach((s,i)=>{offsets.push(Buffer.byteLength(text));text+=(i+1)+' 0 obj\n'+s+'\nendobj\n';});
  const start=Buffer.byteLength(text);text+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n'+start+'\n%%EOF\n';return [...Buffer.from(text)];
}
function crc32(b){let c=0xffffffff;for(const v of b){c^=v;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return(c^0xffffffff)>>>0;}
function docx(){
  const files={'[Content_Types].xml':'<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels':'<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  'word/document.xml':'<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>핵심고객: 제조업 대표</w:t></w:r></w:p><w:p><w:r><w:t>&lt;img src=x onerror=alert(1)&gt;</w:t></w:r></w:p></w:body></w:document>'};
  const local=[],central=[];let offset=0;
  for(const [name,text] of Object.entries(files)){
    const n=Buffer.from(name),b=Buffer.from(text),crc=crc32(b),l=Buffer.alloc(30),c=Buffer.alloc(46);
    l.writeUInt32LE(0x04034b50);l.writeUInt16LE(20,4);l.writeUInt32LE(crc,14);l.writeUInt32LE(b.length,18);l.writeUInt32LE(b.length,22);l.writeUInt16LE(n.length,26);
    c.writeUInt32LE(0x02014b50);c.writeUInt16LE(20,4);c.writeUInt16LE(20,6);c.writeUInt32LE(crc,16);c.writeUInt32LE(b.length,20);c.writeUInt32LE(b.length,24);c.writeUInt16LE(n.length,28);c.writeUInt32LE(offset,42);
    local.push(l,n,b);central.push(c,n);offset+=l.length+n.length+b.length;
  }
  const cd=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(3,8);end.writeUInt16LE(3,10);end.writeUInt32LE(cd.length,12);end.writeUInt32LE(offset,16);
  return [...Buffer.concat([...local,cd,end])];
}
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const start=html.indexOf('// Inline-ready browser helper.'),end=html.indexOf('const INTERVIEW_FIELDS=',start);
assert(start>=0&&end>start,'Production inline extraction helper must be present');
const stageStart=html.indexOf('const INTERVIEW_STAGES='),stageEnd=html.indexOf('function interviewStageLabel',stageStart);
assert(stageStart>=0&&stageEnd>stageStart,'Production stage inference helper must be present');
const source=html.slice(start,end)+'\n'+html.slice(stageStart,stageEnd);
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'text/html'});res.end('<!doctype html><html><body><h1>Isolated parser fixture</h1></body></html>');});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await playwright.chromium.launch({headless:true});
try{
  const page=await browser.newPage(),requests=[];
  page.on('request',r=>requests.push({url:r.url(),method:r.method()}));
  await page.route('**/*',route=>{const url=new URL(route.request().url());return ['127.0.0.1','cdn.jsdelivr.net'].includes(url.hostname)?route.continue():route.abort();});
  await page.goto('http://127.0.0.1:'+server.address().port);await page.addScriptTag({content:source});
  const results=await page.evaluate(async fixture=>{
    const out=[];const file=(bytes,name)=>new File([new Uint8Array(bytes)],name);const expectFailure=async(name,f,options,code)=>{try{await extractInterviewFile(f,options);throw Error('Expected '+code);}catch(e){if(e.code!==code)throw e;out.push(name);}};
    const txt=await extractInterviewFile(new File(['핵심고객: 제조업 대표\n<script>bad()</script>'],'test.txt'));
    if(!txt.text.includes('<script>')||document.querySelectorAll('script').length!==1)throw Error('Text was altered or injected');out.push('UTF8 and markup remain text');
    await expectFailure('Unsupported DOC',new File(['anything'],'test.doc'),{},'unsupported_format');
    // Exercise byte admission with actual File sizes; the read sentinel avoids allocating a second large buffer.
    for(const [name,size,options,accepted] of [
      ['over-old-limit.PDF',10*1024*1024+1,{},true],
      ['boundary.pdf',30*1024*1024,{},true],
      ['oversize.pdf',30*1024*1024+1,{},false],
      ['raised-limit.pdf',30*1024*1024+1,{maxBytes:40*1024*1024},false],
      ['lower-limit.pdf',10*1024*1024+1,{maxBytes:10*1024*1024},false],
      ['boundary.docx',10*1024*1024,{},true],
      ['oversize.docx',10*1024*1024+1,{maxBytes:30*1024*1024},false],
      ['boundary.txt',10*1024*1024,{},true],
      ['oversize.txt',10*1024*1024+1,{maxBytes:30*1024*1024},false]
    ]){
      const sized=new File([new Uint8Array(size)],name);
      sized.arrayBuffer=async()=>{throw Object.assign(new Error('Byte validation reached the reader'),{code:'read_reached'});};
      await expectFailure('Format byte limit: '+name,sized,options,accepted?'read_reached':'file_too_large');
    }
    await expectFailure('Legacy encoding rejected',file([0xb0,0xa1],'test.txt'),{},'encoding');
    await expectFailure('Invalid PDF signature',new File(['not pdf'],'test.pdf'),{},'invalid_pdf');
    await expectFailure('Invalid DOCX ZIP',new File(['not zip'],'test.docx'),{},'invalid_docx');
    await expectFailure('Text limit',new File(['123456'],'test.txt'),{maxChars:5},'too_many_characters');
    const controller=new AbortController();controller.abort();await expectFailure('Cancelled before reading',new File(['hello'],'test.txt'),{signal:controller.signal},'cancelled');
    const pdfResult=await extractInterviewFile(file(fixture.pdf,'test.pdf'));if(!pdfResult.text.includes('core customers')||pdfResult.pageCount!==1)throw Error('PDF text incorrect');out.push('Real pinned PDF parser and worker');
    const scanned=await extractInterviewFile(file(fixture.empty,'scan.pdf'),{allowScannedPdf:true});if(scanned.text!==''||!scanned.needsOCR||scanned.emptyPages[0]!==1)throw Error('Empty PDF handling');out.push('Scanned PDF allowed for native AI');
    await expectFailure('Empty PDF requires notice by default',file(fixture.empty,'scan.pdf'),{},'no_text');
    const doc=await extractInterviewFile(file(fixture.docx,'test.docx'));if(!doc.text.includes('제조업 대표')||!doc.text.includes('<img src=x onerror=alert(1)>'))throw Error('DOCX text incorrect');out.push('Real pinned DOCX parser in worker, no HTML');
    const encrypted=new Uint8Array(fixture.docx);for(let i=0;i<encrypted.length-4;i++)if(encrypted[i]===80&&encrypted[i+1]===75&&encrypted[i+2]===1&&encrypted[i+3]===2){encrypted[i+8]|=1;break;}
    await expectFailure('Encrypted ZIP rejected',file(encrypted,'locked.docx'),{},'encrypted');
    return out;
  },{pdf:pdf(true),empty:pdf(false),docx:docx()});
  for(const r of results)console.log('PASS '+r);
  const stageCases=[
    {name:'신상명세표_아는단계.pdf',text:'신뢰 단계 · 수익 단계',expected:['profile','visibility','credibility','profitability']},
    {name:'meeting.pdf',text:'Visibility CREDIBILITY profitability',expected:['visibility','credibility','profitability']},
    {name:'신상명세표.pdf',text:'아 는 단 계',expected:['profile','visibility']},
    {name:'general-notes.txt',text:'단계가 지정되지 않은 인터뷰 자료',expected:[]}
  ];
  for(const fixture of stageCases){
    assert.deepEqual(await page.evaluate(({name,text})=>inferInterviewStages(name,text),fixture),fixture.expected);
    console.log('PASS Stage inference: '+fixture.name);
  }
  const directory=process.env.INTERVIEW_FIXTURES_DIR?path.resolve(process.env.INTERVIEW_FIXTURES_DIR):fileURLToPath(new URL('../121자료집/',import.meta.url));
  const expectedStages={
    '121미팅플래너_신뢰단계_김경태_20260928.pdf':['profile','credibility'],
    '121미팅플래너_신상명세표_아는단계_김경태_20260928.pdf':['profile','visibility'],
    '송승훈_신뢰단계-2.pdf':['credibility'],
    '송승훈_아는단계-1.pdf':['visibility']
  };
  let actualNames=[];
  try{
    actualNames=(await readdir(directory)).filter(name=>name.toLowerCase().endsWith('.pdf')).sort();
    assert.deepEqual(actualNames,Object.keys(expectedStages).sort(),'The local 121 fixture directory must contain the four expected PDFs');
  }catch(error){
    if(error.code!=='ENOENT')throw error;
    console.log('SKIP Local PDF stage checks: private fixture directory is unavailable. Set INTERVIEW_FIXTURES_DIR to run the four private 121 fixtures.');
  }
  const savedExtractions={};
  for(const name of actualNames){
    const bytes=[...await readFile(path.join(directory,name))];
    const result=await page.evaluate(async({name,bytes,saveText})=>{
      const extracted=await extractInterviewFile(new File([new Uint8Array(bytes)],name,{type:'application/pdf'}),{allowScannedPdf:true});
      return {stages:inferInterviewStages(name,extracted.text),hasText:!!extracted.text.trim(),needsOCR:!!extracted.needsOCR,...(saveText?{raw_text:extracted.text,warnings:extracted.warnings,pageCount:extracted.pageCount}: {})};
    },{name,bytes,saveText:!!process.env.INTERVIEW_EXTRACTION_OUTPUT&&name.includes('김경태')});
    assert(result.hasText||result.needsOCR,`${name}: parser must produce text or an explicit OCR notice.`);
    assert.deepEqual(result.stages,expectedStages[name],`${name}: stage tags should match the file name and extracted headings.`);
    if('raw_text' in result)savedExtractions[name]={source_sha256:createHash('sha256').update(Buffer.from(bytes)).digest('hex'),raw_text:result.raw_text,warnings:result.warnings,needsOCR:result.needsOCR,pageCount:result.pageCount};
    console.log('PASS Local PDF stage inference: '+name+' → '+result.stages.join(', '));
  }
  if(process.env.INTERVIEW_EXTRACTION_OUTPUT){
    assert.equal(Object.keys(savedExtractions).length,2,'Both local Kim PDFs must be available for the requested text export');
    const destination=path.resolve(process.env.INTERVIEW_EXTRACTION_OUTPUT);await mkdir(path.dirname(destination),{recursive:true});await writeFile(destination,JSON.stringify(savedExtractions,null,2)+'\n','utf8');
    console.log('Saved two local PDF extractions; no document text printed.');
  }
  assert(requests.every(r=>r.method==='GET'));assert(requests.some(r=>r.url.includes('pdfjs-dist@6.3.289'))); // Worker requests may be absent from page events.
  console.log(`${results.length} parser fixtures, ${stageCases.length} stage keyword cases, and ${actualNames.length} local PDF stage checks passed; no document text printed and no uploads.`);
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
