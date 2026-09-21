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

function makeMock(initial, options) {
  const clone = value => JSON.parse(JSON.stringify(value));
  const account = (id, role, member = null) => ({ user_id: id, email: `${id}@example.test`, role, member_id: member, requested_member_id: null, request_status: 'none', updated_at: '2026-09-21T00:00:00.000Z' });
  const state = window.__db = {
    members: clone(initial), log: [], pending: [], holdWrites: false, revision: 0,
    pendingReads: [], holdReads: false, completedReads: 0,
    pendingAccessReads: [], holdAccessReads: false, completedAccessReads: 0,
    failReads: options.failReads, failWrites: false, failAccess: options.failAccess, failRpc: false, authError: null, callbacks: [],
    accounts: [account('test-user', options.role || 'admin', options.role === 'member' ? initial[0]?.id : null), account('second-user', 'viewer'), { ...account('pending-user', 'viewer'), requested_member_id: initial[1]?.id, request_status: 'pending' }, { ...account('reject-user', 'viewer'), requested_member_id: initial[2]?.id, request_status: 'pending' }],
    session: options.auth ? { user: { id: 'test-user', email: 'member@example.test' } } : null,
    release() { this.holdWrites = false; this.pending.splice(0).forEach(resolve => resolve()); },
    releaseReads() { this.holdReads = false; this.pendingReads.splice(0).forEach(resolve => resolve()); },
    releaseAccessReads() { this.holdAccessReads = false; this.pendingAccessReads.splice(0).forEach(resolve => resolve()); },
    realtime() { this.callbacks.forEach(callback => callback({ eventType: 'UPDATE' })); },
    setSession(session, event = session ? 'SIGNED_IN' : 'SIGNED_OUT') { this.session = session; this.authCallback?.(event, session); }
  };
  const permissionError = () => ({ data: null, error: { message: 'row-level security policy denied access', code: '42501' } });
  const currentAccount = () => state.accounts.find(row => row.user_id === state.session?.user.id);
  class Query {
    constructor(table) { this.table = table; this.action = 'select'; this.filters = []; this.orders = []; }
    select() { return this; }
    insert(value) { this.action = 'insert'; this.value = clone(value); return this; }
    update(value) { this.action = 'update'; this.value = clone(value); return this; }
    delete() { this.action = 'delete'; return this; }
    eq(key, value) { this.filters.push(row => row[key] === value); return this; }
    in(key, values) { this.filters.push(row => values.includes(row[key])); return this; }
    order(key, options = {}) { this.orders.push([key, options.ascending !== false]); return this; }
    limit(value) { this.max = value; return this; }
    single() { this.one = true; return this; }
    maybeSingle() { this.one = true; this.optional = true; return this; }
    abortSignal() { return this; }
    async execute() {
      state.log.push({ action: this.action, table: this.table, value: this.value });
      const accessRead = this.table === 'member_accounts' && this.action === 'select';
      const accessUser = state.session?.user.id;
      const accessAdmin = currentAccount()?.role === 'admin';
      const accountSnapshot = accessRead ? clone(state.accounts.filter(row => accessAdmin || row.user_id === accessUser)) : null;
      if (accessRead && state.holdAccessReads) await new Promise(resolve => state.pendingAccessReads.push(resolve));
      if (this.action !== 'select' && state.holdWrites) await new Promise(resolve => state.pending.push(resolve));
      if (!accessRead && this.action === 'select' && state.holdReads) await new Promise(resolve => state.pendingReads.push(resolve));
      if (accessRead ? state.failAccess : this.action === 'select' ? state.failReads : state.failWrites) return { data: null, error: { message: accessRead ? '테스트 권한 조회 실패' : '테스트 연결 실패', code: 'TEST_FAILURE' } };
      const matches = row => this.filters.every(filter => filter(row));
      let data;
      if (accessRead) {
        data = accountSnapshot.filter(matches);
      } else if (this.table !== 'members') {
        return permissionError();
      } else if (this.action !== 'select' && currentAccount()?.role !== 'admin' && !(this.action === 'update' && currentAccount()?.role === 'member' && state.members.filter(matches).every(row => row.id === currentAccount().member_id))) {
        return permissionError();
      } else if (this.action === 'insert') {
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
      }
      data.sort((a, b) => { for (const [key, asc] of this.orders) { const n = typeof a[key] === 'number' ? a[key] - b[key] : String(a[key]).localeCompare(String(b[key])); if (n) return asc ? n : -n; } return 0; });
      if (this.max) data = data.slice(0, this.max);
      if (this.one && data.length !== 1 && !(this.optional && !data.length)) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' } };
      if (accessRead) state.completedAccessReads++;
      else if (this.action === 'select') state.completedReads++;
      return { data: clone(this.one ? data[0] ?? null : data), error: null, count: data.length };
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  class Rpc {
    constructor(name, value) { this.name = name; this.value = value; }
    abortSignal() { return this; }
    async execute() {
      state.log.push({ action: 'rpc', name: this.name, value: clone(this.value) });
      if (state.holdWrites) await new Promise(resolve => state.pending.push(resolve));
      if (state.failRpc) return { data: null, error: { message: '테스트 권한 저장 실패', code: 'TEST_FAILURE' } };
      const own = currentAccount();
      if (this.name === 'request_member_access') {
        if (!own) return permissionError();
        Object.assign(own, { requested_member_id: this.value.target_member_id, request_status: 'pending' });
        return { data: clone(own), error: null };
      }
      if (this.name === 'admin_set_member_access') {
        if (own?.role !== 'admin') return permissionError();
        const row = state.accounts.find(row => row.user_id === this.value.target_user_id);
        Object.assign(row, { role: this.value.access_role, member_id: this.value.target_member_id ?? null, request_status: this.value.access_role === 'viewer' ? 'rejected' : 'approved', requested_member_id: null });
        return { data: clone(row), error: null };
      }
      throw new Error(`Unsupported test RPC: ${this.name}`);
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  window.supabase = { createClient: () => ({
    from: table => new Query(table),
    rpc: (name, value) => new Rpc(name, value),
    auth: {
      getSession: async () => ({ data: { session: state.session }, error: null }),
      getUser: async () => ({ data: { user: state.session?.user ?? null }, error: null }),
      onAuthStateChange: callback => { state.authCallback = callback; return { data: { subscription: { unsubscribe() {} } } }; },
      signInWithOtp: async () => { throw new Error('Password authentication must not call signInWithOtp.'); },
      signInWithPassword: async value => {
        state.log.push({ action: 'password-login', value });
        if (state.authError) return { data: {}, error: clone(state.authError) };
        state.setSession({ user: { id: 'test-user', email: value.email } });
        return { data: { session: state.session, user: state.session.user }, error: null };
      },
      signUp: async value => { state.log.push({ action: 'signup', value }); return { data: { user: { id: 'new-user', email: value.email }, session: null }, error: clone(state.authError) }; },
      resetPasswordForEmail: async (email, options) => { state.log.push({ action: 'password-reset', value: { email, options } }); return { data: {}, error: clone(state.authError) }; },
      updateUser: async value => {
        state.log.push({ action: 'password-update', value });
        if (state.authError) return { data: {}, error: clone(state.authError) };
        if (!state.session) return { data: {}, error: { message: 'Auth session missing!', code: 'session_not_found' } };
        state.setSession(state.session, 'USER_UPDATED');
        return { data: { user: state.session.user }, error: null };
      },
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
async function pageFor({ online = false, auth = false, records = seed, failReads = false, role = 'admin', failAccess = false, hash = '' } = {}) {
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
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body: `(${makeMock.toString()})(${JSON.stringify(records)}, ${JSON.stringify({ auth, failReads, role, failAccess })});` })
      : route.abort();
    return route.abort();
  });
  await page.goto(`http://localhost:43127/${hash}`);
  await page.waitForFunction(() => typeof M !== 'undefined' && document.getElementById('cnt').textContent === String(M.length));
  if (online && !failReads) await page.waitForFunction(() => (M[0]?.id || M.length === 0) && window.__db.log.some(x => x.action === 'select') && !document.getElementById('connection-badge').textContent.includes('오프라인'));
  if (failReads) await page.waitForFunction(() => window.__db.log.some(x => x.action === 'select') && document.body.innerText.includes('테스트 연결 실패'));
  if (online && auth) {
    await page.waitForFunction(() => window.__db.log.some(x => x.table === 'member_accounts'));
    if (!failAccess) await page.waitForFunction(() => window.__db.completedAccessReads > 0);
    if (!failAccess && !failReads && role === 'admin') await page.waitForFunction(() => !document.getElementById('newrow').disabled);
    if (!failAccess && !failReads && role === 'member') await page.waitForFunction(() => !document.querySelector('#admintable input').readOnly);
  }
  return { page, context };
}

function mapSeed(rows) {
  return rows.map((m, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: m.n, company: m.co || '', field: m.f || '', team: m.g || '미정', customers: m.c || [], synergies: m.s || [], wants: m.w || '', good_referral: m.v || '', triggers: m.tg || [], is_new: !!m.nw, is_real: !!m.real, sort_order: index, updated_at: '2026-09-21T00:00:00.000Z', updated_by: '' }));
}

async function check(name, run) {
  try { await run(); console.log(`PASS ${name}`); }
  catch (error) { console.error(`FAIL ${name}`); if (failures.length) console.error(JSON.stringify(failures)); throw error; }
}
async function assertPasswordPrivate(page, password) {
  const exposure = await page.evaluate(password => ({
    storage: [...Object.entries(localStorage), ...Object.entries(sessionStorage)].some(pair => pair.some(value => String(value).includes(password))),
    text: document.body.innerText.includes(password),
    url: location.href.includes(password),
    rosterPayload: window.__db.log.filter(item => item.table || item.action === 'rpc').some(item => JSON.stringify(item).includes(password))
  }), password);
  assert.deepEqual(exposure, { storage: false, text: false, url: false, rosterPayload: false }, 'Passwords may only be sent to the SDK authentication method.');
}
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
  await check('Password login uses SDK credentials; logout restores public read-only access', async () => {
    const { page, context } = await pageFor({ online: true });
    const password = 'Fixture-Only!52-password';
    await page.click('#loginb');
    await page.fill('#login-email', 'reader@example.test');
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'password-login') && !document.getElementById('newrow').disabled);
    assert.deepEqual(await page.evaluate(() => window.__db.log.find(x => x.action === 'password-login').value), { email: 'reader@example.test', password });
    await assertPasswordPrivate(page, password);
    if (await page.locator('#login-dialog').isVisible()) await page.click('#close-login');
    await page.click('#t4');
    assert(await page.locator('#newrow').isEnabled());
    assert.equal(await page.locator('#auth-email').innerText(), 'reader@example.test');
    await page.click('#logoutb');
    await page.waitForFunction(() => document.getElementById('newrow').disabled);
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    await context.close();
  });
  await check('Incorrect credentials show actionable feedback and cannot unlock editing', async () => {
    const { page, context } = await pageFor({ online: true });
    const password = 'Wrong-Test-Credential!63';
    await page.evaluate(() => { window.__db.authError = { message: 'Invalid login credentials', code: 'invalid_credentials' }; });
    await page.click('#loginb');
    await page.fill('#login-email', 'reader@example.test');
    await page.fill('#login-password', password);
    await page.click('#login-submit');
    await page.waitForFunction(() => document.getElementById('login-message').classList.contains('error'));
    assert.match(await page.locator('#login-message').innerText(), /이메일|비밀번호/);
    assert.equal(await page.evaluate(() => window.__db.session), null);
    assert(await page.locator('#newrow').isDisabled());
    await assertPasswordPrivate(page, password);
    await context.close();
  });
  await check('Signup validates repeated passwords and requires email confirmation before access', async () => {
    const { page, context } = await pageFor({ online: true });
    const password = 'Signup-Fixture!63-password';
    await page.click('#loginb');
    await page.click('#auth-signup-mode');
    await page.fill('#login-email', 'signup@example.test');
    await page.fill('#login-password', password);
    await page.fill('#login-password-confirm', 'Different-Fixture!92');
    await page.click('#login-submit');
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action === 'signup').length), 0, 'Mismatched passwords must not reach signup.');
    await page.fill('#login-password-confirm', password);
    await page.click('#login-submit');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'signup'));
    const request = await page.evaluate(() => window.__db.log.find(x => x.action === 'signup').value);
    assert.equal(request.email, 'signup@example.test');
    assert.equal(request.password, password);
    assert.match(request.options.emailRedirectTo, /^http:\/\/localhost:43127\//);
    assert.match(await page.locator('#login-message').innerText(), /메일.*(확인|인증)|(확인|인증).*메일/);
    assert.equal(await page.evaluate(() => window.__db.session), null);
    assert(await page.locator('#newrow').isDisabled());
    await assertPasswordPrivate(page, password);
    await context.close();
  });
  await check('Password reset requests a recovery email without sending any password', async () => {
    const { page, context } = await pageFor({ online: true });
    await page.click('#loginb');
    await page.click('#auth-reset-mode');
    await page.fill('#login-email', 'reset@example.test');
    await page.click('#login-submit');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'password-reset'));
    const request = await page.evaluate(() => window.__db.log.find(x => x.action === 'password-reset').value);
    assert.equal(request.email, 'reset@example.test');
    assert.match(request.options.redirectTo, /^http:\/\/localhost:43127\//);
    assert(!Object.hasOwn(request, 'password') && !Object.hasOwn(request.options, 'password'));
    assert.match(await page.locator('#login-message').innerText(), /메일/);
    assert.equal(await page.evaluate(() => window.__db.session), null);
    await context.close();
  });
  await check('Recovery events open a new-password form and save through updateUser', async () => {
    const { page, context } = await pageFor({ online: true });
    const password = 'Recovery-Fixture!85-password';
    await page.evaluate(() => window.__db.setSession({ user: { id: 'test-user', email: 'recover@example.test' } }, 'PASSWORD_RECOVERY'));
    await page.waitForFunction(() => document.getElementById('login-dialog').open && document.getElementById('login-dialog').dataset.mode === 'password');
    await page.fill('#login-password', password);
    await page.fill('#login-password-confirm', password);
    await page.click('#login-submit');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'password-update'));
    assert.deepEqual(await page.evaluate(() => window.__db.log.find(x => x.action === 'password-update').value), { password });
    await assertPasswordPrivate(page, password);
    await context.close();
  });
  await check('Existing signed-in users can set a password without gaining member permissions', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, role: 'viewer' });
    const password = 'Existing-Fixture!31-password';
    await page.click('#passwordb');
    assert.equal(await page.locator('#login-dialog').getAttribute('data-mode'), 'password');
    await page.fill('#login-password', password);
    await page.fill('#login-password-confirm', password);
    await page.click('#login-submit');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'password-update'));
    assert.deepEqual(await page.evaluate(() => window.__db.log.find(x => x.action === 'password-update').value), { password });
    assert(await page.locator('#newrow').isDisabled());
    await assertPasswordPrivate(page, password);
    await context.close();
  });
  await check('Expired recovery sessions explain reauthentication instead of claiming a password save', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, role: 'viewer' });
    const password = 'Expired-Fixture!31-password';
    await page.evaluate(() => window.__db.setSession(window.__db.session, 'PASSWORD_RECOVERY'));
    await page.waitForFunction(() => document.getElementById('login-dialog').open && document.getElementById('login-dialog').dataset.mode === 'password');
    await page.fill('#login-password', password);
    await page.fill('#login-password-confirm', password);
    await page.evaluate(() => { window.__db.authError = { message: 'Auth session missing!', code: 'session_not_found' }; });
    await page.click('#login-submit');
    await page.waitForFunction(() => document.getElementById('login-message').classList.contains('error'));
    assert.match(await page.locator('#login-message').innerText(), /로그인|만료|재설정|다시/);
    assert(await page.locator('#newrow').isDisabled());
    await assertPasswordPrivate(page, password);
    await context.close();
  });
  await check('Expired email links explain how to request a fresh password recovery link', async () => {
    const { page, context } = await pageFor({ online: true, hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired' });
    await page.waitForFunction(() => /만료|유효하지|다시.*요청/.test(document.body.innerText));
    assert(await page.locator('#newrow').isDisabled());
    if (!await page.locator('#login-dialog').isVisible()) await page.click('#loginb');
    if (await page.locator('#login-dialog').getAttribute('data-mode') !== 'reset') await page.click('#auth-reset-mode');
    await page.fill('#login-email', 'retry@example.test');
    await page.click('#login-submit');
    await page.waitForFunction(() => window.__db.log.some(x => x.action === 'password-reset'));
    await context.close();
  });
  await check('Viewers read all members, remain read-only, and can request their own member link', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, role: 'viewer' });
    await page.click('#t4');
    assert.equal(await page.evaluate(() => M.length), 31);
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    for (const selector of ['#newrow', '#bulkb', '#importb']) assert(await page.locator(selector).isDisabled(), selector);
    assert(await page.locator('#admintable .del').evaluateAll(buttons => buttons.every(button => button.disabled)));
    assert(await page.locator('#exportb').isEnabled());
    await page.selectOption('#request-member', seed[0].id);
    await page.click('#request-access');
    await page.waitForFunction(() => window.__db.log.some(x => x.name === 'request_member_access'));
    assert.deepEqual(await page.evaluate(() => window.__db.log.find(x => x.name === 'request_member_access').value), { target_member_id: seed[0].id });
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)), 'An access request must not grant rights before approval.');
    assert.equal(await page.evaluate(() => window.__db.accounts[0].role), 'viewer');
    await context.close();
  });
  await check('Members edit only their own row and cannot add, delete, import or bulk-update', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, role: 'member' });
    await page.click('#t4');
    const rows = page.locator('#admintable tbody tr');
    assert(await rows.first().locator('input').evaluateAll(inputs => inputs.every(input => !input.readOnly)));
    assert(await rows.nth(1).locator('input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    await page.click('#own-memberb');
    const ownPosition = await page.evaluate(() => {
      const own = document.querySelector('#admintable .own-row'), other = document.querySelector('#admintable tr:not(.own-row) input')?.closest('tr');
      return { top: own.getBoundingClientRect().top, navBottom: document.querySelector('nav').getBoundingClientRect().bottom, ownBackground: getComputedStyle(own).backgroundColor, otherBackground: getComputedStyle(other).backgroundColor };
    });
    assert(ownPosition.top >= ownPosition.navBottom - 1 && ownPosition.top < 900, `Own-member navigation must leave the row below sticky tabs: ${JSON.stringify(ownPosition)}`);
    assert.notEqual(ownPosition.ownBackground, ownPosition.otherBackground, 'The editable own row must remain visually highlighted on mobile.');
    for (const selector of ['#newrow', '#bulkb', '#importb']) assert(await page.locator(selector).isDisabled(), selector);
    assert(await page.locator('#admintable .del').evaluateAll(buttons => buttons.every(button => button.disabled)));
    const own = rows.first().locator('input[data-k="co"]');
    await own.fill('본인 회사 수정');
    await own.dispatchEvent('change');
    await page.waitForFunction(() => M[0].co === '본인 회사 수정');
    // Dispatch directly too, to verify event handlers do not rely only on disabled/readonly UI.
    const prior = await page.evaluate(() => window.__db.log.filter(x => x.table === 'members' && x.action !== 'select').length);
    await rows.nth(1).locator('input[data-k="co"]').evaluate(input => { input.value = '허용되지 않은 타인 변경'; input.dispatchEvent(new Event('change', { bubbles: true })); });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(resolve)));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.table === 'members' && x.action !== 'select').length), prior);
    assert.equal(await page.evaluate(() => window.__db.members[1].company), seed[1].company);
    await context.close();
  });
  await check('Access lookup failures fail closed and cannot reuse prior administrator privileges', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, failAccess: true });
    await page.click('#t4');
    await page.waitForFunction(() => /권한을 확인하지 못해|테스트 권한 조회 실패/.test(document.body.innerText));
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    assert(await page.locator('#newrow').isDisabled());
    await context.close();
    const active = await pageFor({ online: true, auth: true });
    await active.page.click('#t4');
    await active.page.evaluate(() => { window.__db.failAccess = true; });
    await active.page.locator('#admintable tbody tr:first-child input[data-k="co"]').fill('권한 확인 실패 변경');
    await active.page.locator('#admintable tbody tr:first-child input[data-k="co"]').dispatchEvent('change');
    await active.page.waitForFunction(() => /권한을 확인하지 못해|테스트 권한 조회 실패/.test(document.body.innerText));
    assert.equal(await active.page.evaluate(() => window.__db.log.filter(x => x.table === 'members' && x.action !== 'select').length), 0, 'Failed authorization revalidation must stop writes.');
    assert(await active.page.locator('#newrow').isDisabled());
    await active.context.close();
  });
  await check('Late access responses from an earlier signed-in user cannot authorize a new user', async () => {
    const { page, context } = await pageFor({ online: true });
    await page.evaluate(() => { window.__db.holdAccessReads = true; window.__db.setSession({ user: { id: 'test-user', email: 'admin@example.test' } }); });
    await page.waitForFunction(() => window.__db.pendingAccessReads.length > 0);
    await page.evaluate(() => { window.__db.holdAccessReads = false; window.__db.setSession({ user: { id: 'second-user', email: 'viewer@example.test' } }); });
    await page.waitForFunction(() => window.__db.completedAccessReads > 0 && document.getElementById('auth-email').textContent === 'viewer@example.test');
    await page.evaluate(async () => { window.__db.releaseAccessReads(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    await page.click('#t4');
    assert.equal(await page.locator('#auth-email').innerText(), 'viewer@example.test');
    assert(await page.locator('#newrow').isDisabled());
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    await context.close();
  });
  await check('Administrators approve or reject member access only after successful RPC responses', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    const target = page.locator('#accountstable tr[data-user-id="pending-user"]');
    await target.waitFor();
    await target.locator('.account-role').selectOption('member');
    await target.locator('.account-member').selectOption(seed[1].id);
    await page.evaluate(() => { window.__db.holdWrites = true; });
    await target.locator('.account-save').click();
    await page.waitForFunction(() => window.__db.pending.length > 0);
    assert.equal(await page.evaluate(() => window.__db.accounts.find(row => row.user_id === 'pending-user').role), 'viewer');
    await page.evaluate(() => window.__db.release());
    await page.waitForFunction(() => window.__db.accounts.find(row => row.user_id === 'pending-user').role === 'member');
    assert.deepEqual(await page.evaluate(() => window.__db.log.find(row => row.name === 'admin_set_member_access').value), { target_user_id: 'pending-user', access_role: 'member', target_member_id: seed[1].id });
    const reject = page.locator('#accountstable tr[data-user-id="reject-user"]');
    await page.waitForFunction(() => !document.querySelector('#accountstable tr[data-user-id="reject-user"] .account-reject').disabled);
    await page.evaluate(() => { window.__db.failRpc = true; });
    await reject.locator('.account-reject').click();
    await page.waitForFunction(() => /테스트 권한 저장 실패/.test(document.body.innerText));
    assert.equal(await page.evaluate(() => window.__db.accounts.find(row => row.user_id === 'reject-user').request_status), 'pending', 'Failed rejection must not alter access.');
    await page.evaluate(() => { window.__db.failRpc = false; });
    await reject.locator('.account-reject').click();
    await page.waitForFunction(() => window.__db.accounts.find(row => row.user_id === 'reject-user').request_status === 'rejected');
    assert.equal(await page.evaluate(() => window.__db.accounts.find(row => row.user_id === 'reject-user').member_id), null);
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
  await check('Password forms and viewer/member/admin permissions fit 400px in light and dark themes', async () => {
    const reader = await pageFor({ online: true });
    await reader.page.click('#loginb');
    for (const theme of ['light', 'dark']) {
      await reader.page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const mode of ['login', 'signup', 'reset']) {
        await reader.page.click(`#auth-${mode}-mode`);
        const sizes = await reader.page.locator('#login-dialog').evaluate(dialog => ({ width: innerWidth, right: dialog.getBoundingClientRect().right, left: dialog.getBoundingClientRect().left, content: dialog.scrollWidth, client: dialog.clientWidth }));
        assert(sizes.left >= 0 && sizes.right <= sizes.width && sizes.content <= sizes.client, `${theme} ${mode}: ${JSON.stringify(sizes)}`);
      }
    }
    await reader.context.close();
    for (const role of ['viewer', 'member', 'admin']) {
      const { page, context } = await pageFor({ online: true, auth: true, role });
      await page.click('#t4');
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const sizes = await page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(sizes.html <= sizes.width && sizes.body <= sizes.width, `${theme} ${role}: ${JSON.stringify(sizes)}`);
      }
      await page.click('#passwordb');
      const dimensions = await page.locator('#login-dialog').evaluate(dialog => ({ right: dialog.getBoundingClientRect().right, content: dialog.scrollWidth, client: dialog.clientWidth }));
      assert(dimensions.right <= 400 && dimensions.content <= dimensions.client, `${role} password form: ${JSON.stringify(dimensions)}`);
      await context.close();
    }
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
    const reader = await pageFor({ online: true });
    await reader.page.click('#loginb');
    for (const theme of ['light', 'dark']) {
      await reader.page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      for (const mode of ['login', 'signup', 'reset']) {
        await reader.page.click(`#auth-${mode}-mode`);
        const name = `browser-400-${theme}-auth-${mode}.png`;
        await reader.page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
        console.log(`SCREENSHOT diagnostics-output/${name}`);
      }
    }
    await reader.context.close();
    for (const role of ['viewer', 'member', 'admin']) {
      const rolePage = await pageFor({ online: true, auth: true, role });
      await rolePage.page.click('#t4');
      for (const theme of ['light', 'dark']) {
        await rolePage.page.evaluate(theme => { document.documentElement.dataset.theme = theme; scrollTo(0, 0); }, theme);
        const name = `browser-400-${theme}-role-${role}.png`;
        await rolePage.page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
        console.log(`SCREENSHOT diagnostics-output/${name}`);
        const content = role === 'admin' ? rolePage.page.locator('#accounts-panel') : role === 'viewer' ? rolePage.page.locator('#member-access-panel') : rolePage.page.locator('#admintable .own-row').first();
        await content.evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - 145));
        const contentName = role === 'admin' ? `browser-400-${theme}-accounts.png` : `browser-400-${theme}-${role}-content.png`;
        await rolePage.page.screenshot({ path: path.join(directory, contentName), animations: 'disabled' });
      }
      await rolePage.page.click('#passwordb');
      await rolePage.page.screenshot({ path: path.join(directory, `browser-400-dark-${role}-password.png`), animations: 'disabled' });
      await rolePage.context.close();
    }
  }
} finally { await browser.close(); }
