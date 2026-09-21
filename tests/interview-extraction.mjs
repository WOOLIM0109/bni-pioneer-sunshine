// Synthetic documents only. Loads the pinned CDN parsers but never uploads a file.
// Run: node tests/interview-extraction.mjs
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import path from 'node:path';
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
const start=html.indexOf('// Inline-ready browser helper.'),end=html.indexOf('/* ---------- 비공개 정보 · 인터뷰 문서 ---------- */',start);
assert(start>=0&&end>start,'Production inline extraction helper must be present');
const source=html.slice(start,end);
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
  assert(requests.every(r=>r.method==='GET'));assert(requests.some(r=>r.url.includes('pdfjs-dist@6.3.289'))); // Worker requests may be absent from page events.
  console.log(results.length+' parser fixture tests passed; synthetic content only; no uploads.');
}finally{await browser.close();await new Promise(resolve=>server.close(resolve));}
