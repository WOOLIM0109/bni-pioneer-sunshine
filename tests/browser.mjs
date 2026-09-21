// Isolated browser regression checks. All network requests are intercepted;
// authentication and database writes only touch the in-memory test client.
// Run: node tests/browser.mjs [--screenshots]
// Optionally set PLAYWRIGHT_MODULE to a locally installed playwright/core module.
import assert from 'node:assert/strict';
import { readFile, readdir, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
async function getPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_MODULE, 'playwright', 'playwright-core'].filter(Boolean);
  const links = path.join(homedir(), 'AppData', 'Local', 'ms-playwright', '.links');
  try { for (const file of await readdir(links)) candidates.push((await readFile(path.join(links, file), 'utf8')).trim()); } catch {}
  for (const candidate of candidates) { try { return require(candidate); } catch {} }
  throw new Error('Install Playwright separately or set PLAYWRIGHT_MODULE to an existing installation.');
}

function makeMock(initial, authenticated, failReads) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const state = window.__db = {
    members: clone(initial), log: [], pending: [], holdWrites: false, revision: 0,
    pendingReads: [], holdReads: false, completedReads: 0,
    failReads, failWrites: false, callbacks: [],
    session: authenticated ? { user: { id: 'test-user', email: 'member@example.test' } } : null,
    release() { this.holdWrites = false; this.pending.splice(0).forEach(resolve => resolve()); },
    releaseReads() { this.holdReads = false; this.pendingReads.splice(0).forEach(resolve => resolve()); },
    realtime() { this.callbacks.forEach(callback => callback({ eventType: 'UPDATE' })); },
    setSession(session) { this.session = session; this.authCallback?.(session ? 'SIGNED_IN' : 'SIGNED_OUT', session); }
  };
  class Query {
    constructor() { this.action = 'select'; this.filters = []; this.orders = []; }
    select() { return this; }
    insert(value) { this.action = 'insert'; this.value = clone(value); return this; }
    update(value) { this.action = 'update'; this.value = clone(value); return this; }
    delete() { this.action = 'delete'; return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    order(key, options = {}) { this.orders.push([key, options.ascending !== false]); return this; }
    limit(value) { this.max = value; return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; return this; }
    abortSignal() { return this; }
    async execute() {
      state.log.push({ action: this.action, value: this.value });
      if (this.action !== 'select' && state.holdWrites) await new Promise(resolve => state.pending.push(resolve));
      if (this.action === 'select' && state.holdReads) await new Promise(resolve => state.pendingReads.push(resolve));
      if (this.action === 'select' ? state.failReads : state.failWrites) return { data: null, error: { message: '테스트 연결 실패', code: 'TEST_FAILURE' } };
      const matches = row => this.filters.every(filter => filter(row));
      let data;
      if (this.action === 'insert') {
        data = (Array.isArray(this.value) ? this.value : [this.value]).map((row, i) => ({
          id: crypto.randomUUID(), company: '', field: '', team: '미정', customers: [], synergies: [], wants: '',
          good_referral: '', triggers: [], is_new: false, is_real: false, sort_order: state.members.length + i,
          updated_at: new Date(Date.now() + ++state.revision).toISOString(), updated_by: state.session?.user.email || '', ...row
        }));
        state.members.push(...data);
      } else if (this.action === 'update') {
        data = state.members.filter(matches);
        data.forEach(row => Object.assign(row, this.value, { updated_at: new Date(Date.now() + ++state.revision).toISOString(), updated_by: state.session?.user.email || '' }));
      } else if (this.action === 'delete') {
        data = state.members.filter(matches);
        state.members = state.members.filter(row => !matches(row));
      } else {
        data = state.members.filter(matches);
        data.sort((a, b) => { for (const [key, asc] of this.orders) { const n = typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key])); if (n) return asc ? n : -n; } return 0; });
      }
      if (this.max) data = data.slice(0, this.max);
      if (this.one && data.length !== 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      if (this.action === 'select') state.completedReads++;
      return { data: clone(this.one ? data[0] ?? null : data), error: null, count: data.length };
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  window.supabase = { createClient: () => ({
    from: () => new Query(),
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      onAuthStateChange: callback => { state.authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOtp: async value => { state.log.push({ action: 'otp', value }); return { data: {}, error: null }; },
      signOut: async () => { state.setSession(null); return { error: null }; }
    },
    channel: () => ({
      on(event, filter, callback) { state.callbacks.push(callback); return this; },
      subscribe(callback) { queueMicrotask(() => callback?.('SUBSCRIBED')); return this; },
      unsubscribe() {}
    }),
    removeChannel() {}
  }) };
}

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert(!html.includes('service_role'), 'The HTML must not mention privileged credentials.');
assert(!html.includes('pioneer-sunshine-roster-v1') && !html.includes('pioneer-sunshine-v2'), 'Roster localStorage must be removed.');
assert(html.includes('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js'), 'Supabase CDN must be version-pinned.');

const { chromium } = await getPlaywright();
const browser = await chromium.launch({ headless: true });
const failures = [];
let seed;
async function pageFor({ online = false, auth = false, records = seed, failReads = false } = {}) {
  const context = await browser.newContext({ viewport: { width: 400, height: 900 }, colorScheme: 'light', serviceWorkers: 'block' });
  const page = await context.newPage();
  page.on('pageerror', error => failures.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  // Strip production configuration in every mode, including the offline tests.
  const document = html.replace(/(const\s+SUPABASE_URL\s*=\s*)['"][^'"]*['"]/, online ? '$1"https://test-project.supabase.co"' : '$1""')
    .replace(/(const\s+SUPABASE_ANON_KEY\s*=\s*)['"][^'"]*['"]/, online ? '$1"eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.test"' : '$1""');
  await page.route('**/*', async route => {
    const url = route.request().url();
    if (url === 'http://localhost:43127/') return route.fulfill({ status: 200, contentType: 'text/html', body: document });
    if (url.includes('/@supabase/supabase-js@')) return online
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body: `(${makeMock.toString()})(${JSON.stringify(records)}, ${auth}, ${failReads});` })
      : route.abort();
    return route.abort();
  });
  await page.goto('http://localhost:43127/');
  await page.waitForFunction(() => typeof M !== 'undefined' && document.getElementById('cnt').textContent === String(M.length));
  if (online && !failReads) await page.waitForFunction(() => (M[0]?.id || M.length === 0) && window.__db.log.some(x => x.action === 'select') && !document.getElementById('connection-badge').textContent.includes('오프라인'));
  if (failReads) await page.waitForFunction(() => window.__db.log.some(x => x.action === 'select') && document.body.innerText.includes('테스트 연결 실패'));
  return { page, context };
}

function mapSeed(rows) {
  return rows.map((m, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: m.n, company: m.co || '', field: m.f || '', team: m.g || '미정', customers: m.c || [], synergies: m.s || [], wants: m.w || '', good_referral: m.v || '', triggers: m.tg || [], is_new: !!m.nw, is_real: !!m.real, sort_order: index, updated_at: '2026-09-21T00:00:00.000Z', updated_by: '' }));
}

async function check(name, run) { await run(); console.log(`PASS ${name}`); }
try {
  await check('Offline fallback renders all 31 seed members and permits only export', async () => {
    const { page, context } = await pageFor();
    assert.equal(await page.evaluate(() => M.length), 31);
    seed = mapSeed(await page.evaluate(() => M));
    assert.match(await page.locator('body').innerText(), /오프라인.*읽기 전용/);
    await page.click('#t4');
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    for (const selector of ['#newrow', '#bulkb', '#importb']) assert(await page.locator(selector).isDisabled(), selector);
    assert(await page.locator('#exportb').isEnabled());
    await page.click('#exportb');
    assert.equal(JSON.parse(await page.inputValue('#io')).length, 31);
    await context.close();
  });
  await check('Anonymous online readers see persisted members and cannot mutate', async () => {
    const records = [...seed, { ...seed[0], id: '00000000-0000-4000-8000-999999999999', name: '공유된 멤버', sort_order: 31 }];
    const { page, context } = await pageFor({ online: true, records });
    assert.equal(await page.evaluate(() => M.length), 32);
    await page.click('#t4');
    assert.match(await page.locator('#v4').innerText(), /수정하려면 로그인하세요/);
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select').length), 0);
    await context.close();
  });
  await check('A failed database read falls back to seed data and disables authenticated writes', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, failReads: true });
    assert.equal(await page.evaluate(() => M.length), 31);
    assert.match(await page.locator('#connection-badge').innerText(), /오프라인.*읽기 전용/);
    await page.click('#t4');
    for (const selector of ['#newrow', '#bulkb', '#importb']) assert(await page.locator(selector).isDisabled(), selector);
    await context.close();
  });
  await check('An empty database renders a clear empty state and accepts the first authenticated insert', async () => {
    const { page, context } = await pageFor({ online: true, records: [] });
    assert.equal(await page.evaluate(() => M.length), 0);
    assert.match(await page.locator('#v1').innerText(), /등록된 멤버가 없습니다/);
    await page.click('#t4');
    assert(await page.locator('#newrow').isDisabled());
    await page.evaluate(() => window.__db.setSession({ user: { id: 'test-user', email: 'reader@example.test' } }));
    await page.click('#newrow');
    await page.waitForFunction(() => M.length === 1);
    assert.equal(await page.evaluate(() => window.__db.members[0].sort_order), 0);
    await context.close();
  });
  await check('Email OTP uses the current URL; auth state changes unlock editing and logout locks it', async () => {
    const { page, context } = await pageFor({ online: true });
    await page.click('#loginb');
    await page.fill('#login-email', 'reader@example.test');
    await page.click('#send-link');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'otp'));
    assert.deepEqual(await page.evaluate(() => window.__db.log.find(x => x.action === 'otp').value), { email: 'reader@example.test', options: { emailRedirectTo: 'http://localhost:43127/' } });
    assert.match(await page.locator('#login-message').innerText(), /메일함을 확인하세요/);
    await page.click('#close-login');
    await page.evaluate(() => window.__db.setSession({ user: { id: 'test-user', email: 'reader@example.test' } }));
    await page.click('#t4');
    assert(await page.locator('#newrow').isEnabled());
    assert.equal(await page.locator('#auth-email').innerText(), 'reader@example.test');
    await page.click('#logoutb');
    await page.waitForFunction(() => document.getElementById('newrow').disabled);
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    await context.close();
  });
  await check('Authenticated updates commit only after success and failed updates restore saved values', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    const cell = page.locator('#admintable tbody tr:first-child input[data-k="co"]');
    const original = await cell.inputValue();
    await page.evaluate(() => { window.__db.holdWrites = true; });
    await cell.fill('성공 후 회사');
    await cell.dispatchEvent('change');
    await page.waitForFunction(() => window.__db.pending.length === 1);
    assert.equal(await page.evaluate(() => M[0].co), original);
    await page.evaluate(() => window.__db.release());
    await page.waitForFunction(() => M[0].co === '성공 후 회사');
    await page.evaluate(() => { window.__db.failWrites = true; });
    await cell.fill('실패한 회사');
    await cell.dispatchEvent('change');
    await page.waitForFunction(() => document.body.innerText.includes('테스트 연결 실패'));
    assert.equal(await page.evaluate(() => M[0].co), '성공 후 회사');
    assert.equal(await cell.inputValue(), '성공 후 회사');
    await context.close();
  });
  await check('Insert/delete are committed after responses; realtime reloads shared changes', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    await page.evaluate(() => { window.__db.holdWrites = true; });
    await page.click('#newrow');
    await page.waitForFunction(() => window.__db.pending.length === 1);
    assert.equal(await page.evaluate(() => M.length), 31);
    await page.evaluate(() => window.__db.release());
    await page.waitForFunction(() => M.length === 32);
    await page.locator('#admintable tbody tr:last-child .del').click();
    await page.waitForFunction(() => M.length === 31);
    await page.evaluate(() => { window.__db.members[0].company = '실시간 변경 회사'; window.__db.realtime(); });
    await page.waitForFunction(() => M[0].co === '실시간 변경 회사');
    await context.close();
  });
  await check('Bulk explicitly updates known names and inserts new names; ambiguous names are blocked', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    const name = seed[0].name;
    await page.fill('#bulk', `${name}, 일괄회사, 일괄분야, 미정\n새일괄멤버, 새회사, 새분야, 미정`);
    await page.click('#bulkb');
    await page.waitForFunction(() => M.some(m => m.n === '새일괄멤버'));
    assert.equal(await page.evaluate(name => M.find(m => m.n === name).co, name), '일괄회사');
    assert.deepEqual(await page.evaluate(() => [...new Set(window.__db.log.filter(x => x.action !== 'select').map(x => x.action))].sort()), ['insert', 'update']);
    await page.evaluate(name => { window.__db.members.push({ ...window.__db.members.find(m => m.name === name), id: crypto.randomUUID() }); window.__db.realtime(); }, name);
    await page.waitForFunction(() => M.length === 33);
    const count = await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select').length);
    await page.fill('#bulk', `${name}, 모호한수정, 분야, 미정`);
    await page.click('#bulkb');
    await page.waitForFunction(() => /동명이인|중복|같은 이름/.test(document.getElementById('bulkmsg').textContent));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select').length), count);
    await context.close();
  });
  await check('JSON import rejects invalid fields and maps valid existing/new members without deleting others', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    await page.fill('#io', JSON.stringify([{ n: seed[0].name, c: '잘못된 문자열' }]));
    await page.click('#importb');
    await page.waitForFunction(() => document.getElementById('iomsg').classList.contains('error'));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select').length), 0);
    const imported = { n: seed[0].name, co: 'JSON 회사', c: ['JSON 고객'], s: ['JSON 직군'], w: 'JSON 비지터', v: 'JSON 리퍼럴', tg: ['JSON 트리거'], nw: true, real: true };
    await page.fill('#io', JSON.stringify([imported, { n: 'JSON 새 멤버', co: '새 회사', f: '새 전문분야', g: '미정', c: [], s: [] }]));
    await page.click('#importb');
    await page.waitForFunction(() => M.some(m => m.n === 'JSON 새 멤버'));
    assert.equal(await page.evaluate(() => M.length), 32);
    const persisted = await page.evaluate(name => window.__db.members.find(m => m.name === name), seed[0].name);
    assert.deepEqual([persisted.company, persisted.customers, persisted.synergies, persisted.wants, persisted.good_referral, persisted.triggers, persisted.is_new, persisted.is_real], ['JSON 회사', ['JSON 고객'], ['JSON 직군'], 'JSON 비지터', 'JSON 리퍼럴', ['JSON 트리거'], true, true]);
    assert.equal(persisted.field, seed[0].field, 'Omitted fields remain unchanged on existing members.');
    assert.equal(await page.evaluate(() => window.__db.members.filter(m => m.id.startsWith('00000000-0000-4000-8000-')).length), 31);
    await context.close();
  });
  await check('A delayed background refresh cannot discard a draft typed after the read started', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    const cell = page.locator('#admintable tbody tr:first-child input[data-k="co"]');
    const original = await cell.inputValue();
    await page.evaluate(() => { window.__db.holdReads = true; window.__db.realtime(); });
    await page.waitForFunction(() => window.__db.pendingReads.length > 0);
    await cell.fill('응답 도중 입력한 회사');
    await page.evaluate(async () => {
      window.__db.releaseReads();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    assert.equal(await cell.inputValue(), '응답 도중 입력한 회사', 'Background reads must preserve the active draft input.');
    assert.equal(await page.evaluate(() => M[0].co), original, 'Drafts must not become saved roster data before change/write.');
    await page.click('#admin-note');
    await page.waitForFunction(() => M[0].co === '응답 도중 입력한 회사');
    await context.close();
  });
  await check('Object prototype names are safe as customer, synergy, field, and team values', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    const priorReads = await page.evaluate(() => window.__db.completedReads);
    await page.evaluate(() => {
      Object.assign(window.__db.members[0], { customers: ['constructor', '__proto__', 'toString'], synergies: ['toString', 'constructor', '__proto__'], field: 'constructor', team: '__proto__' });
      window.__db.realtime();
    });
    await page.waitForFunction(priorReads => window.__db.completedReads > priorReads, priorReads);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => M[0].g), '__proto__');
    assert.deepEqual(await page.evaluate(() => M[0].c), ['constructor', '__proto__', 'toString']);
    assert(!/오프라인/.test(await page.locator('#connection-badge').innerText()));
    await page.click('#t3');
    assert.match(await page.locator('#custtable').innerText(), /constructor/);
    await context.close();
  });
  await check('Every tab fits a 400px viewport in both themes', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const tab of ['#t1', '#t2', '#t3', '#t4']) {
        await page.click(tab);
        const sizes = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(sizes.html <= sizes.width && sizes.body <= sizes.width, `${theme} ${tab}: ${JSON.stringify(sizes)}`);
      }
    }
    await context.close();
  });
  assert.deepEqual(failures, [], 'No browser runtime errors');
  console.log('All browser checks passed. No external authentication or data writes were performed.');
  if (process.argv.includes('--screenshots')) {
    const directory = fileURLToPath(new URL('../diagnostics-output', import.meta.url));
    await mkdir(directory, { recursive: true });
    const { page, context } = await pageFor({ online: true, auth: true });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const view of ['v1', 'v4']) {
        await page.click(view === 'v1' ? '#t1' : '#t4');
        await page.evaluate(() => scrollTo(0, 0));
        const name = `browser-400-${theme}-${view}.png`;
        await page.screenshot({ path: path.join(directory, name), fullPage: view === 'v1', animations: 'disabled' });
        console.log(`SCREENSHOT diagnostics-output/${name}`);
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; scrollTo(0, 0); });
    await page.click('#t1');
    await page.screenshot({ path: path.join(directory, 'browser-desktop-light-v1.png'), fullPage: true, animations: 'disabled' });
    console.log('SCREENSHOT diagnostics-output/browser-desktop-light-v1.png');
    await context.close();
  }
} finally { await browser.close(); }
