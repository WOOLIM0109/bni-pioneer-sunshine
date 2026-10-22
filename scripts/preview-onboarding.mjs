// Local-only walkthrough. Uses the existing in-memory test client; never connects
// to the hosted database or sends authentication emails.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { renderPage, routesFromHtml } from './build-pages.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const port = Number(process.env.SUNSHINE_PREVIEW_PORT || 43128);
const baseUrl = `http://localhost:${port}/`;
const banner = `<aside id="local-preview-bar" aria-label="로컬 미리보기" style="display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap;padding:10px 16px;background:#22242a;color:white;font:13px/1.5 sans-serif"><strong>로컬 미리보기</strong><span>체험용 데이터 · 실제 명단에 저장되지 않아요</span><label>회원 상태 <select id="local-preview-state" style="font:inherit;padding:5px;border-radius:4px;color:#222;background:white"><option value="member">승인된 회원</option><option value="new">가입 직후</option><option value="pending">승인 대기</option><option value="admin">관리자</option></select></label><button id="local-preview-restart" style="font:inherit;padding:5px 10px;border-radius:4px;cursor:pointer">처음 안내 다시 보기</button></aside>`;
const controls = `document.addEventListener('DOMContentLoaded',()=>{
  const mode=new URLSearchParams(location.search).get('preview')||'member';
  document.getElementById('local-preview-state').value=mode;
  document.getElementById('local-preview-state').onchange=event=>{location.href='/sunshine/?preview='+event.target.value;};
  document.getElementById('local-preview-restart').onclick=()=>{
    for(const key of Object.keys(localStorage))if(key.startsWith('sunshine-profile-guide-v1:'))localStorage.removeItem(key);
    localStorage.removeItem('sunshine-preview-auth-metadata');
    location.href='/sunshine/?preview='+mode;
  };
},{once:true});`;

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, baseUrl);
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; font-src 'self' https://cdn.jsdelivr.net; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'");
    if (url.pathname === '/__preview/controls.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return response.end(controls);
    }
    if (url.pathname === '/__preview/sdk.js') {
      const html = await readFile(root + '/index.html', 'utf8');
      const tests = await readFile(root + '/tests/browser.mjs', 'utf8');
      const mock = tests.slice(tests.indexOf('function makeMock('), tests.indexOf('\nconst html ='));
      if (!mock.startsWith('function makeMock(') || !mock.trim().endsWith('}')) throw new Error('Cannot read isolated preview client.');
      const seedSource = html.slice(html.indexOf('let M = ['), html.indexOf('const DEFAULT_M='));
      const members = runInNewContext(seedSource + ';M', {}, { timeout: 1000 });
      const rows = members.map((m, index) => ({ id: `b0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: m.n, company: m.co, field: m.f, chapter_role: m.role || null, customers: m.c || [], synergies: m.s || [], wants: m.w || '', is_new: !!m.nw, is_real: !!m.real, sort_order: index, updated_at: '2026-10-10T00:00:00Z' }));
      const own = rows.find(row => row.name === '이소연') || rows[0];
      // The mock links its signed-in member to the first record. The public list
      // still sorts by the original sort_order, exercising the scroll-to-row flow.
      const initial = [own, ...rows.filter(row => row !== own)];
      own.wants = '';
      const mode = ['new', 'pending', 'admin'].includes(url.searchParams.get('mode')) ? url.searchParams.get('mode') : 'member';
      const groupSql=await readFile(root+'/supabase/customer-group-map-apply.sql','utf8');
      const customerGroupSeed=JSON.parse(groupSql.match(/\$customer_groups\$([\s\S]*?)\$customer_groups\$/)[1]);
      const options = { auth: true, role: mode === 'admin' ? 'admin' : mode === 'member' ? 'member' : 'viewer',customerGroupSeed };
      const setup = `window.__db.session.user.email='sunshine-preview@example.test';window.__db.userMetadata['test-user']={...window.__db.userMetadata['test-user'],full_name:${JSON.stringify(own.name)}};window.__db.session.user.user_metadata=window.__db.userMetadata['test-user'];window.__db.details.forEach(row=>{row.good_referral='';row.triggers=[];row.customer_companies=[];});${mode === 'pending' ? `window.__db.accounts[0].requested_member_id=${JSON.stringify(own.id)};window.__db.accounts[0].request_status='pending';` : ''}`;
      response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      return response.end(`${mock}\nlet previewMetadata={};try{previewMetadata=JSON.parse(localStorage.getItem('sunshine-preview-auth-metadata')||'{}');}catch{}\nwindow.__persistAuthMetadata=async next=>{localStorage.setItem('sunshine-preview-auth-metadata',JSON.stringify(next));};\nmakeMock(${JSON.stringify(initial)},{...${JSON.stringify(options)},userMetadata:previewMetadata});${setup}`);
    }
    if (url.pathname === '/assets/pioneer-sunshine-share.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      return response.end(await readFile(root + url.pathname));
    }
    let html = await readFile(root + '/index.html', 'utf8');
    const route = routesFromHtml(html).find(item => url.pathname === `/${item.slug}/`);
    if (!route && !['/', '/index.html'].includes(url.pathname)) {
      response.writeHead(404); return response.end('Not found');
    }
    const mode = ['new', 'pending', 'admin'].includes(url.searchParams.get('preview')) ? url.searchParams.get('preview') : 'member';
    html = html.replace(/(const\s+SUPABASE_URL\s*=\s*)['"][^'"]*['"]/, '$1"https://test-project.supabase.co"')
      .replace(/(const\s+SUPABASE_ANON_KEY\s*=\s*)['"][^'"]*['"]/, '$1"eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.test"')
      .replace('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js', `/__preview/sdk.js?mode=${mode}`)
      .replace('<body>', '<body>' + banner)
      .replace('</head>', '<script defer src="/__preview/controls.js"></script></head>');
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end(renderPage(html, route || null, { baseUrl }));
  } catch (error) {
    console.error(error.message);
    response.writeHead(500); response.end('Local preview failed. Check the server output.');
  }
});
server.listen(port, '127.0.0.1', () => console.log(`Local onboarding preview: ${baseUrl}sunshine/`));
