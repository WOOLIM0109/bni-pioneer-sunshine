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
    members: clone(initial), links: clone(options.links || []), failLinkReads: !!options.failLinkReads, log: [], pending: [], holdWrites: false, revision: 0,
    pendingReads: [], holdReads: false, completedReads: 0,
    pendingAccessReads: [], holdAccessReads: false, completedAccessReads: 0,
    pendingStorageWrites: [], holdStorageWrites: false, failStorageWrites: false, failStorageReads: false,
    pendingPrivateReads: [], holdPrivateReads: false, pendingAnalysis: [], holdAnalysis: false, failAnalysis: false, aiConfigured: true,
    storageObjects: Object.create(null), interviews: [],
    details: initial.map(row => ({ member_id: row.id, good_referral: `PRIVATE_REFERRAL_${row.id}`, triggers: [`PRIVATE_TRIGGER_${row.id}`], customer_companies: [`PRIVATE_COMPANY_${row.id}`], revision: 1 })),
    failReads: options.failReads, failWrites: false, failAccess: options.failAccess, failRpc: false, failRpcName: null, holdRpcName: null, authError: null, callbacks: [],
    accounts: [account('test-user', options.role || 'admin', options.role === 'member' ? initial[0]?.id : null), account('second-user', 'viewer'), { ...account('pending-user', 'viewer'), requested_member_id: initial[1]?.id, request_status: 'pending' }, { ...account('reject-user', 'viewer'), requested_member_id: initial[2]?.id, request_status: 'pending' }],
    session: options.auth ? { user: { id: 'test-user', email: 'member@example.test' } } : null,
    release() { this.holdWrites = false; this.pending.splice(0).forEach(resolve => resolve()); },
    releaseReads() { this.holdReads = false; this.pendingReads.splice(0).forEach(resolve => resolve()); },
    releaseAccessReads() { this.holdAccessReads = false; this.pendingAccessReads.splice(0).forEach(resolve => resolve()); },
    releaseStorageWrites() { this.holdStorageWrites = false; this.pendingStorageWrites.splice(0).forEach(resolve => resolve()); },
    releasePrivateReads() { this.holdPrivateReads = false; this.pendingPrivateReads.splice(0).forEach(resolve => resolve()); },
    releaseAnalysis() { this.holdAnalysis = false; this.pendingAnalysis.splice(0).forEach(resolve => resolve()); },
    realtime() { this.callbacks.forEach(callback => callback({ eventType: 'UPDATE' })); },
    setSession(session, event = session ? 'SIGNED_IN' : 'SIGNED_OUT') { this.session = session; this.authCallback?.(event, session); }
  };
  const permissionError = () => ({ data: null, error: { message: 'row-level security policy denied access', code: '42501' } });
  const currentAccount = () => state.accounts.find(row => row.user_id === state.session?.user.id);
  const timestamp = () => new Date(Date.now() + ++state.revision).toISOString();
  const conflict = () => ({ data: null, error: { message: '다른 관리자가 문서 또는 멤버를 변경했습니다. 다시 열어 최신 내용을 확인하세요.', code: '40001' } });
  const detailFor = memberId => state.details.find(row => row.member_id === memberId) || { member_id: memberId, good_referral: '', triggers: [], customer_companies: [], revision: 0 };
  const publicInterview = row => Object.fromEntries(['id', 'member_id', 'original_name', 'mime_type', 'file_size', 'status', 'revision', 'created_at', 'updated_at'].map(key => [key, row[key]]));
  class Query {
    constructor(table) { this.table = table; this.action = 'select'; this.filters = []; this.orders = []; this.columns = '*'; }
    select(columns = '*') { this.columns = columns; return this; }
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
      state.log.push({ action: this.action, table: this.table, columns: this.columns, value: this.value });
      const accessRead = this.table === 'member_accounts' && this.action === 'select';
      const linkRead = this.table === 'member_synergy_links' && this.action === 'select';
      const accessUser = state.session?.user.id;
      const accessAdmin = currentAccount()?.role === 'admin';
      const accountSnapshot = accessRead ? clone(state.accounts.filter(row => accessAdmin || row.user_id === accessUser)) : null;
      if (accessRead && state.holdAccessReads) await new Promise(resolve => state.pendingAccessReads.push(resolve));
      if (this.action !== 'select' && state.holdWrites) await new Promise(resolve => state.pending.push(resolve));
      if (!accessRead && this.action === 'select' && state.holdReads) await new Promise(resolve => state.pendingReads.push(resolve));
      if (accessRead ? state.failAccess : this.action === 'select' ? state.failReads : state.failWrites) return { data: null, error: { message: accessRead ? '테스트 권한 조회 실패' : '테스트 연결 실패', code: 'TEST_FAILURE' } };
      if (linkRead && state.failLinkReads) return { data: null, error: { message: '테스트 연결 지정 조회 실패', code: 'TEST_LINK_FAILURE' } };
      const matches = row => this.filters.every(filter => filter(row));
      let data;
      if (accessRead) {
        data = accountSnapshot.filter(matches);
      } else if (linkRead) {
        data = state.links.filter(matches);
      } else if (this.table !== 'members') {
        return permissionError();
      } else if (['good_referral', 'triggers', 'customer_companies'].some(key => this.columns.split(',').includes(key) || Object.hasOwn(this.value || {}, key))) {
        return permissionError();
      } else if (this.action !== 'select' && currentAccount()?.role !== 'admin' && !(this.action === 'update' && currentAccount()?.role === 'member' && state.members.filter(matches).every(row => row.id === currentAccount().member_id))) {
        return permissionError();
      } else if (this.action === 'insert') {
        data = (Array.isArray(this.value) ? this.value : [this.value]).map((row, i) => ({
          id: crypto.randomUUID(), company: '', field: '', team: '미정', customers: [], synergies: [], wants: '',
          is_new: false, is_real: false, sort_order: state.members.length + i,
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
      if (this.columns !== '*') data = data.map(row => Object.fromEntries(this.columns.split(',').map(key => key.trim()).filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])));
      return { data: clone(this.one ? data[0] ?? null : data), error: null, count: data.length };
    }
    then(resolve, reject) { return this.execute().then(resolve, reject); }
  }
  class Rpc {
    constructor(name, value) { this.name = name; this.value = value; }
    abortSignal() { return this; }
    async execute() {
      const readOnly = ['get_member_details', 'list_member_interviews', 'get_member_interview'].includes(this.name);
      state.log.push({ action: 'rpc', name: this.name, value: clone(this.value), readOnly });
      if (readOnly) {
        const reader = clone(currentAccount() || null);
        let data;
        if (this.name === 'get_member_details') {
          if (!reader || reader.role === 'viewer') return { data: [], error: null };
          data = clone(state.details.filter(row => (reader.role === 'admin' || row.member_id === reader.member_id) && (!this.value?.target_member_id || row.member_id === this.value.target_member_id)));
        } else {
          if (reader?.role !== 'admin') return permissionError();
          data = this.name === 'list_member_interviews'
            ? clone(state.interviews.filter(row => !this.value?.target_member_id || row.member_id === this.value.target_member_id).map(publicInterview))
            : clone(state.interviews.find(row => row.id === this.value?.target_interview_id) || null);
        }
        if (state.holdPrivateReads) await new Promise(resolve => state.pendingPrivateReads.push(resolve));
        if (state.failRpc && (!state.failRpcName || state.failRpcName === this.name)) return { data: null, error: { message: '테스트 비공개 정보 조회 실패', code: 'TEST_FAILURE' } };
        return { data, error: null };
      }
      if (state.holdWrites && (!state.holdRpcName || state.holdRpcName === this.name)) await new Promise(resolve => state.pending.push(resolve));
      if (state.failRpc && (!state.failRpcName || state.failRpcName === this.name)) return { data: null, error: { message: '테스트 권한 저장 실패', code: 'TEST_FAILURE' } };
      const own = currentAccount();
      if (this.name === 'set_member_synergy_link') {
        if (own?.role !== 'admin') return permissionError();
        const input = this.value, member = state.members.find(row => row.id === input.source_member_id);
        const invalid = () => ({ data: null, error: { message: '멤버와 상생직군을 최신 목록에서 다시 확인하세요.', code: '22023' } });
        if (!member || input.target_member_id === member.id || !member.synergies.includes(input.synergy)) return invalid();
        if (member.updated_at !== input.expected_member_updated_at) return conflict();
        const link = state.links.find(row => row.source_member_id === member.id && row.synergy === input.synergy);
        if ((link?.updated_at ?? null) !== (input.expected_link_updated_at ?? null)) return conflict();
        if (input.target_member_id !== null && !state.members.some(row => row.id === input.target_member_id)) return invalid();
        state.links = state.links.filter(row => row !== link);
        if (input.target_member_id === null) return { data: null, error: null };
        const next = { source_member_id: member.id, synergy: input.synergy, target_member_id: input.target_member_id, updated_at: timestamp() };
        state.links.push(next);
        return { data: clone(next), error: null };
      }
      if (this.name === 'update_member_details') {
        if (own?.role !== 'admin' && !(own?.role === 'member' && own.member_id === this.value.target_member_id)) return permissionError();
        const detail = detailFor(this.value.target_member_id), member = state.members.find(row => row.id === this.value.target_member_id);
        if (!member || detail.revision !== this.value.expected_revision) return conflict();
        const next = { ...detail, ...clone(this.value.details_patch), revision: detail.revision + 1 };
        state.details = state.details.filter(row => row.member_id !== next.member_id).concat(next);
        member.updated_at = timestamp();
        return { data: { ...clone(next), member_updated_at: member.updated_at }, error: null };
      }
      if (['create_member_interview', 'save_member_interview_draft', 'apply_member_interview'].includes(this.name)) {
        if (own?.role !== 'admin') return permissionError();
        const input = this.value;
        if (this.name === 'create_member_interview') {
          const object = state.storageObjects[`member-interviews/${input.storage_path}`];
          if (!object || !input.storage_path.startsWith(`${input.target_member_id}/`)) return { data: null, error: { message: '비공개 원본 파일을 먼저 업로드하세요.', code: '22023' } };
          const row = { id: crypto.randomUUID(), member_id: input.target_member_id, storage_path: input.storage_path, original_name: input.original_name, mime_type: object.type, file_size: object.size, raw_text: '', extracted: {}, public_patch: {}, private_patch: {}, status: 'draft', revision: 1, created_at: timestamp(), updated_at: timestamp(), created_by: own.user_id, updated_by: own.user_id, applied_at: null, history: [] };
          state.interviews.push(row);
          return { data: clone(row), error: null };
        }
        const row = state.interviews.find(row => row.id === input.target_interview_id);
        if (!row || row.revision !== input.expected_revision) return conflict();
        if (this.name === 'save_member_interview_draft') {
          const patch = clone(input.draft_patch);
          if (Object.hasOwn(patch, 'replace_review') && typeof patch.replace_review !== 'boolean') return { data: null, error: { code: '22023', message: '잘못된 검토 저장 방식입니다.' } };
          const next = { raw_text: row.raw_text, extracted: row.extracted, public_patch: row.public_patch, private_patch: row.private_patch, status: patch.status ?? 'draft' };
          for (const key of ['raw_text', 'extracted']) if (Object.hasOwn(patch, key)) next[key] = patch[key];
          for (const key of ['public_patch', 'private_patch']) if (Object.hasOwn(patch, key)) next[key] = patch.replace_review === true ? patch[key] : { ...row[key], ...patch[key] };
          if (Object.keys(next).some(key => JSON.stringify(row[key]) !== JSON.stringify(next[key]))) Object.assign(row, next, { revision: row.revision + 1, updated_at: timestamp(), updated_by: own.user_id });
          return { data: clone(row), error: null };
        }
        const member = state.members.find(member => member.id === row.member_id);
        if (!member || member.updated_at !== input.expected_member_updated_at || row.status === 'applied') return conflict();
        const detail = detailFor(row.member_id);
        Object.assign(member, clone(input.public_patch || {}), { updated_at: timestamp() });
        const next = { ...detail, ...clone(input.private_patch || {}), revision: detail.revision + 1 };
        state.details = state.details.filter(item => item.member_id !== next.member_id).concat(next);
        Object.assign(row, { public_patch: clone(input.public_patch || {}), private_patch: clone(input.private_patch || {}), revision: row.revision + 1, status: 'applied', applied_at: timestamp(), updated_at: timestamp() });
        return { data: { interview_id: row.id, revision: row.revision, status: 'applied', member_id: row.member_id, member_updated_at: member.updated_at, details_revision: next.revision }, error: null };
      }
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
  class StorageBucket {
    constructor(bucket) { this.bucket = bucket; }
    async upload(objectPath, body, uploadOptions = {}) {
      state.log.push({ action: 'storage-upload', bucket: this.bucket, path: objectPath, options: clone(uploadOptions), name: body.name || '', size: body.size, type: body.type });
      if (state.holdStorageWrites) await new Promise(resolve => state.pendingStorageWrites.push(resolve));
      if (currentAccount()?.role !== 'admin') return permissionError();
      if (state.failStorageWrites) return { data: null, error: { message: '테스트 비공개 원본 저장 실패', code: 'TEST_STORAGE_FAILURE' } };
      const key = `${this.bucket}/${objectPath}`;
      if (state.storageObjects[key] && !uploadOptions.upsert) return { data: null, error: { message: 'The resource already exists', statusCode: '409' } };
      state.storageObjects[key] = { body, name: body.name || '', type: uploadOptions.contentType || body.type, size: body.size };
      return { data: { path: objectPath, id: crypto.randomUUID(), fullPath: key }, error: null };
    }
    async download(objectPath) {
      state.log.push({ action: 'storage-download', bucket: this.bucket, path: objectPath });
      if (currentAccount()?.role !== 'admin') return permissionError();
      if (state.failStorageReads) return { data: null, error: { message: '테스트 비공개 원본 읽기 실패', code: 'TEST_STORAGE_FAILURE' } };
      const entry = state.storageObjects[`${this.bucket}/${objectPath}`];
      return entry ? { data: entry.body, error: null } : { data: null, error: { message: 'Object not found', statusCode: '404' } };
    }
    async remove(paths) {
      state.log.push({ action: 'storage-remove', bucket: this.bucket, paths: clone(paths) });
      if (currentAccount()?.role !== 'admin') return permissionError();
      paths.forEach(objectPath => delete state.storageObjects[`${this.bucket}/${objectPath}`]);
      return { data: paths.map(name => ({ name })), error: null };
    }
    async createSignedUrl(objectPath, expiresIn) {
      state.log.push({ action: 'storage-sign', bucket: this.bucket, path: objectPath, expiresIn });
      if (currentAccount()?.role !== 'admin') return permissionError();
      return { data: { signedUrl: `https://private-fixture.invalid/${encodeURIComponent(this.bucket)}/${encodeURIComponent(objectPath)}` }, error: null };
    }
    getPublicUrl(objectPath) {
      state.log.push({ action: 'storage-public-url', bucket: this.bucket, path: objectPath });
      return { data: { publicUrl: `https://public-fixture.invalid/${encodeURIComponent(objectPath)}` } };
    }
  }
  window.supabase = { createClient: () => ({
    from: table => new Query(table),
    rpc: (name, value) => new Rpc(name, value),
    storage: { from: bucket => new StorageBucket(bucket) },
    functions: { invoke: async (name, options = {}) => {
      const readOnly = options.method === 'GET';
      state.log.push({ action: 'function', name, value: clone(options.body || {}), method: options.method || 'POST', readOnly });
      if (currentAccount()?.role !== 'admin') return permissionError();
      if (readOnly) return { data: { configured: state.aiConfigured }, error: null };
      const row = state.interviews.find(item => item.id === options.body?.interview_id);
      if (!row || row.revision !== options.body?.expected_revision) return conflict();
      if (state.holdAnalysis) await new Promise(resolve => state.pendingAnalysis.push(resolve));
      if (state.failAnalysis) return { data: null, error: { message: 'Edge Function returned a non-2xx status code', context: { json: async () => ({ error: { code: 'invalid_analysis', message: '분석 결과를 검토안으로 읽지 못했습니다. 원문은 보관되어 있습니다. 오류 코드: analysis_shape' } }) } } };
      const suggestions = state.analysisSuggestions || [
        { key: 'customers', value: ['지역 소상공인', '학원 운영자'], reason: '공통 고객 유형을 정리했습니다.', evidence: 'AI_PRIVATE_EVIDENCE 고객 유형 원문', confidence: 'high', basis: 'stated' },
        { key: 'synergies', value: ['앱·웹개발', '세무사'], reason: '공통 고객을 만나는 직군입니다.', evidence: 'AI_PRIVATE_EVIDENCE 연결 근거 원문', confidence: 'medium', basis: 'inferred' },
        { key: 'team', value: ['기업'], reason: '기업 고객을 공유합니다.', evidence: '', confidence: 'medium', basis: 'inferred' },
        { key: 'good_referral', value: ['INTERVIEW_PRIVATE_REFERRAL 검증 고객'], reason: '대표가 직접 요청했습니다.', evidence: 'AI_PRIVATE_EVIDENCE 좋은 리퍼럴 원문', confidence: 'high', basis: 'stated' },
        { key: 'triggers', value: ['INTERVIEW_PRIVATE_TRIGGER 정부지원 사업이 궁금해요', 'INTERVIEW_PRIVATE_TRIGGER 서류 준비가 어려워요'], reason: '인터뷰에 나온 요청 문장입니다.', evidence: 'AI_PRIVATE_EVIDENCE 트리거 원문', confidence: 'high', basis: 'stated' },
        { key: 'customer_companies', value: ['INTERVIEW_PRIVATE_COMPANY 샘플기업'], reason: '고객사명은 비공개 항목입니다.', evidence: 'AI_PRIVATE_EVIDENCE 고객사 원문', confidence: 'high', basis: 'stated' }
      ];
      Object.assign(row, { extracted: { summary: '인터뷰 검증 요약', detected_name: state.members.find(member => member.id === row.member_id)?.name || '', warnings: [], suggestions: clone(suggestions) }, public_patch: {}, private_patch: {}, revision: row.revision + 1, updated_at: timestamp() });
      return { data: clone(row), error: null };
    } },
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
async function pageFor({ online = false, auth = false, records = seed, links = [], failLinkReads = false, failReads = false, role = 'admin', failAccess = false, hash = '' } = {}) {
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
      ? route.fulfill({ status: 200, contentType: 'application/javascript', body: `(${makeMock.toString()})(${JSON.stringify(records)}, ${JSON.stringify({ auth, failReads, role, failAccess, links, failLinkReads })});` })
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
  return rows.map((m, index) => ({ id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`, name: m.n, company: m.co || '', field: m.f || '', team: m.g || '미정', customers: m.c || [], synergies: m.s || [], wants: m.w || '', is_new: !!m.nw, is_real: !!m.real, sort_order: index, updated_at: '2026-09-21T00:00:00.000Z', updated_by: '' }));
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
const INTERVIEW_SOURCE = 'PRIVATE_INTERVIEW_SOURCE 검증용 원본입니다.\n이름: 인터뷰 테스트 멤버\n핵심 고객: 지역 소상공인과 학원 운영자\n상생 직군: 앱·웹개발, 세무사\n좋은 리퍼럴: 정부지원 사업을 준비하는 대표\n고객사: PRIVATE_SOURCE_COMPANY 비공개 고객사\n이 말이 들리면 연결: 서류 준비가 어려워요.\n이 자료는 테스트 메모리에서만 사용합니다.';
async function uploadInterview(page, memberId = seed[0].id) {
  await page.click('#t4');
  await page.selectOption('#interview-member', memberId);
  await page.setInputFiles('#interview-file', { name: '검증-인터뷰.txt', mimeType: 'text/plain', buffer: Buffer.from(INTERVIEW_SOURCE, 'utf8') });
  await page.click('#interview-upload');
  await page.waitForFunction(() => window.__db.interviews.some(row => row.raw_text.includes('PRIVATE_INTERVIEW_SOURCE')));
  return page.evaluate(() => window.__db.interviews.at(-1).id);
}
async function analyzeInterview(page) {
  await page.click('#interview-analyze');
  await page.waitForFunction(() => document.querySelectorAll('#interview-review [data-field] .interview-check').length > 0);
}
async function assertPublicExportPrivate(page) {
  await page.click('#t4');
  await page.click('#exportb');
  const exported = await page.inputValue('#io');
  const rows = JSON.parse(exported);
  assert(rows.every(row => !['v', 'tg', 'good_referral', 'triggers', 'customer_companies', 'raw_text', 'extracted', 'storage_path', 'private_patch'].some(key => Object.hasOwn(row, key))), 'Public exports must contain only public roster fields.');
  assert(!/PRIVATE_|INTERVIEW_PRIVATE_|member-interviews\//.test(exported), 'Private content and object paths must not reach public JSON exports.');
  const leak = await page.evaluate(() => ({ roster: /PRIVATE_|INTERVIEW_PRIVATE_/.test(JSON.stringify(M)), storage: [...Object.entries(localStorage), ...Object.entries(sessionStorage)].some(pair => /PRIVATE_|INTERVIEW_PRIVATE_|member-interviews\//.test(JSON.stringify(pair))) }));
  assert.deepEqual(leak, { roster: false, storage: false }, 'Private documents/details must stay out of the public roster and browser persistence.');
}
function connectionFixtures() {
  return seed.slice(0, 4).map((row, index) => ({ ...structuredClone(row),
    name: ['연결 요청자', '연결 대상', '같은 분야 하나', '같은 분야 둘'][index],
    company: ['요청 회사', '대상 회사', '둘째 회사', '셋째 회사'][index],
    field: ['경영 상담', '앱·웹개발', '동일 분야', '동일　분야'][index],
    team: '기업', customers: ['공통 고객'], synergies: index ? [] : ['홈페이지 제작', '동일 분야']
  }));
}
async function openConnectionReview(page, memberId) {
  await page.click('#t4');
  if (!await page.locator('#link-review-details').evaluate(details => details.open)) await page.click('#link-review-details > summary');
  await page.selectOption('#link-member', memberId);
}
async function saveInterviewReview(page) {
  const revision = await page.evaluate(() => interviewDoc.revision);
  await page.click('#interview-save');
  await page.waitForFunction(revision => !interviewBusy && interviewDoc.revision > revision, revision);
}
async function reloadInterviewReview(page, id) {
  await page.selectOption('#interview-history', id);
  const reads = await page.evaluate(() => window.__db.log.filter(item => item.name === 'get_member_interview').length);
  await page.click('#interview-open');
  await page.waitForFunction(reads => !interviewBusy && window.__db.log.filter(item => item.name === 'get_member_interview').length > reads, reads);
}
try {
  await check('Offline fallback renders all 31 seed members and permits only export', async () => {
    const { page, context } = await pageFor();
    assert.equal(await page.evaluate(() => M.length), 31);
    assert(await page.evaluate(() => M.every(member => !['v', 'tg', 'good_referral', 'triggers', 'customer_companies'].some(key => Object.hasOwn(member, key)))), 'Offline seed data is shipped publicly and must not embed private referral fields.');
    seed = mapSeed(await page.evaluate(() => M));
    assert.match(await page.locator('body').innerText(), /오프라인.*읽기 전용/);
    assert(await page.locator('#connection-badge').isVisible(), 'Offline status must remain visible when project settings are missing.');
    assert(await page.locator('#retryb').isVisible());
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
    await page.locator('#connection-badge').waitFor({ state: 'hidden' });
    assert(await page.locator('#connection-detail').isHidden(), 'Routine successful connection status should not occupy the header.');
    await page.click('#t4');
    assert.match(await page.locator('#v4').innerText(), /수정하려면 로그인하세요/);
    assert(await page.locator('#admintable input').evaluateAll(inputs => inputs.every(input => input.readOnly)));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select' && !x.readOnly).length), 0);
    await context.close();
  });
  await check('A failed database read falls back to seed data and disables authenticated writes', async () => {
    const { page, context } = await pageFor({ online: true, auth: true, failReads: true });
    assert.equal(await page.evaluate(() => M.length), 31);
    assert.match(await page.locator('#connection-badge').innerText(), /오프라인.*읽기 전용/);
    assert(await page.locator('#connection-badge').isVisible(), 'Connection failures must retain a visible offline warning.');
    assert(await page.locator('#connection-detail').isVisible());
    assert(await page.locator('#retryb').isVisible());
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
    for (const [userId, hint] of [['test-user', '전체 멤버 관리 · 연결 불필요'], ['second-user', '읽기 전용 · 연결 불필요']]) {
      const row = page.locator(`#accountstable tr[data-user-id="${userId}"]`);
      assert(await row.locator('.account-member').isHidden(), `${userId}: non-member roles must not show a member selector.`);
      assert(await row.locator('.account-member').isDisabled());
      assert.equal(await row.locator('.account-member-hint').innerText(), hint);
    }
    await target.locator('.account-role').focus();
    await target.locator('.account-role').selectOption('member');
    assert(await target.locator('.account-member').isVisible());
    assert(await target.locator('.account-member').isEnabled());
    assert.equal(await target.locator('.account-member-hint').innerText(), '본인 확인 후 이 계정이 수정할 멤버를 선택하세요.');
    await target.locator('.account-member').selectOption(seed[2].id);
    await target.locator('.account-role').selectOption('admin');
    assert(await target.locator('.account-member').isHidden());
    assert(await target.locator('.account-member').isDisabled());
    assert.equal(await target.locator('.account-member-hint').innerText(), '전체 멤버 관리 · 연결 불필요');
    await target.locator('.account-role').selectOption('member');
    assert(await target.locator('.account-member').isVisible());
    assert(await target.locator('.account-member').isEnabled());
    assert.equal(await target.locator('.account-member').inputValue(), seed[2].id, 'Changing a draft role away from member and back must preserve the selected member.');
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => !item.readOnly && (item.action === 'rpc' || (item.table && item.action !== 'select'))).length), 0, 'Role/member selections alone must not save account permissions.');
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
    assert.deepEqual(await page.evaluate(() => [...new Set(window.__db.log.filter(x => x.action !== 'select' && !x.readOnly).map(x => x.action))].sort()), ['insert', 'update']);
    await page.evaluate(name => { window.__db.members.push({ ...window.__db.members.find(m => m.name === name), id: crypto.randomUUID() }); window.__db.realtime(); }, name);
    await page.waitForFunction(() => M.length === 33);
    const count = await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select' && !x.readOnly).length);
    await page.fill('#bulk', `${name}, 모호한수정, 분야, 미정`);
    await page.click('#bulkb');
    await page.waitForFunction(() => /동명이인|중복|같은 이름/.test(document.getElementById('bulkmsg').textContent));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select' && !x.readOnly).length), count);
    await context.close();
  });
  await check('JSON import rejects invalid fields and maps valid existing/new members without deleting others', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    await page.fill('#io', JSON.stringify([{ n: seed[0].name, c: '잘못된 문자열' }]));
    await page.click('#importb');
    await page.waitForFunction(() => document.getElementById('iomsg').classList.contains('error'));
    assert.equal(await page.evaluate(() => window.__db.log.filter(x => x.action !== 'select' && !x.readOnly).length), 0);
    const imported = { n: seed[0].name, co: 'JSON 회사', c: ['JSON 고객'], s: ['JSON 직군'], w: 'JSON 비지터', nw: true, real: true };
    await page.fill('#io', JSON.stringify([imported, { n: 'JSON 새 멤버', co: '새 회사', f: '새 전문분야', g: '미정', c: [], s: [] }]));
    await page.click('#importb');
    await page.waitForFunction(() => M.some(m => m.n === 'JSON 새 멤버'));
    assert.equal(await page.evaluate(() => M.length), 32);
    const persisted = await page.evaluate(name => window.__db.members.find(m => m.name === name), seed[0].name);
    assert.deepEqual([persisted.company, persisted.customers, persisted.synergies, persisted.wants, persisted.is_new, persisted.is_real], ['JSON 회사', ['JSON 고객'], ['JSON 직군'], 'JSON 비지터', true, true]);
    assert(!Object.hasOwn(persisted, 'good_referral') && !Object.hasOwn(persisted, 'triggers'), 'Public imports must not contain private referral details.');
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
  await check('Private member details stay permission-scoped and never enter public exports', async () => {
    for (const role of ['anonymous', 'viewer', 'member', 'admin']) {
      const { page, context } = await pageFor({ online: true, auth: role !== 'anonymous', role: role === 'anonymous' ? 'viewer' : role });
      await page.click('#t4');
      if (role === 'member' || role === 'admin') await page.waitForFunction(() => window.__db.log.some(row => row.name === 'get_member_details'));
      await assertPublicExportPrivate(page);
      if (role === 'anonymous' || role === 'viewer') {
        const exposure = await page.evaluate(() => /PRIVATE_|INTERVIEW_PRIVATE_/.test(document.body.innerText + Array.from(document.querySelectorAll('input,textarea')).map(input => input.value).join(' ')));
        assert.equal(exposure, false, `${role} must not receive private member details.`);
      } else if (role === 'member') {
        const other = await page.locator('#admintable tbody tr:nth-child(2) input').evaluateAll(inputs => inputs.map(input => input.value).join(' '));
        assert(!other.includes('PRIVATE_'), 'A member must not see another member’s referral details.');
      }
      await context.close();
    }
  });
  await check('Only administrators can operate interview uploads, including direct event dispatch', async () => {
    for (const role of ['anonymous', 'viewer', 'member']) {
      const { page, context } = await pageFor({ online: true, auth: role !== 'anonymous', role: role === 'anonymous' ? 'viewer' : role });
      await page.click('#t4');
      assert(await page.locator('#interview-panel').isHidden(), `${role}: interview upload must be hidden.`);
      await page.setInputFiles('#interview-file', { name: '차단검증.txt', mimeType: 'text/plain', buffer: Buffer.from(INTERVIEW_SOURCE) });
      await page.evaluate(() => document.getElementById('interview-upload').dispatchEvent(new Event('click', { bubbles: true })));
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await page.evaluate(() => window.__db.log.filter(row => row.action.startsWith('storage-') || row.name === 'create_member_interview' || (row.action === 'function' && !row.readOnly)).length), 0, `${role}: hidden controls must still enforce authorization.`);
      await context.close();
    }
  });
  await check('Interview upload stores a private original for the exact selected member UUID without changing the roster', async () => {
    const records = seed.map(row => ({ ...row }));
    records[1] = { ...records[1], name: records[0].name, company: '동명이인 구분 회사' };
    const { page, context } = await pageFor({ online: true, auth: true, records });
    const before = await page.evaluate(() => JSON.stringify(M));
    const id = await uploadInterview(page, records[1].id);
    const result = await page.evaluate(async id => {
      const row = window.__db.interviews.find(item => item.id === id);
      const file = window.__db.storageObjects[`member-interviews/${row.storage_path}`];
      return { row, original: await file.body.text(), upload: window.__db.log.find(item => item.action === 'storage-upload'), create: window.__db.log.find(item => item.name === 'create_member_interview') };
    }, id);
    assert.equal(result.row.member_id, records[1].id, 'Selection must use UUID even when names are duplicated.');
    assert.equal(result.create.value.target_member_id, records[1].id);
    assert.match(result.row.storage_path, new RegExp(`^${records[1].id}/[a-zA-Z0-9-]+\\.txt$`));
    assert.equal(result.upload.bucket, 'member-interviews');
    assert.notEqual(result.upload.options.upsert, true, 'Every original must use a new object path.');
    assert.equal(result.original, INTERVIEW_SOURCE);
    assert.equal(result.row.raw_text, INTERVIEW_SOURCE);
    assert.equal(await page.evaluate(() => JSON.stringify(M)), before, 'Uploading/extracting must not mutate public roster data.');
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.action === 'function' && !item.readOnly).length), 0, 'AI analysis must require its own explicit action.');
    assert.equal(await page.locator('#interview-raw').inputValue(), INTERVIEW_SOURCE);
    assert(await page.locator('#interview-raw').evaluate(input => input.readOnly));
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.action === 'storage-public-url').length), 0);
    await assertPublicExportPrivate(page);
    await context.close();
  });
  await check('Unsupported files and storage failures cannot create interviews or alter member data', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4');
    await page.selectOption('#interview-member', seed[0].id);
    await page.setInputFiles('#interview-file', { name: 'unsupported.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('not a document') });
    await page.locator('#interview-upload').evaluate(button => button.dispatchEvent(new Event('click', { bubbles: true })));
    await page.waitForFunction(() => /형식|PDF|DOCX|TXT|지원/.test(document.getElementById('interview-file-note').textContent + document.getElementById('interview-message').textContent));
    assert.equal(await page.evaluate(() => window.__db.log.filter(row => row.action === 'storage-upload').length), 0);
    await page.setInputFiles('#interview-file', { name: '저장실패.txt', mimeType: 'text/plain', buffer: Buffer.from(INTERVIEW_SOURCE) });
    await page.evaluate(() => { window.__db.failStorageWrites = true; });
    await page.click('#interview-upload');
    await page.waitForFunction(() => /실패/.test(document.getElementById('interview-message').textContent + document.getElementById('interview-file-note').textContent));
    assert.equal(await page.evaluate(() => window.__db.interviews.length), 0);
    assert.equal(await page.evaluate(() => window.__db.log.filter(row => row.name === 'create_member_interview' || row.name === 'apply_member_interview').length), 0);
    assert.deepEqual(await page.evaluate(() => M[0].c), seed[0].customers);
    await context.close();
  });
  await check('PDF and DOCX upload flows preserve originals and use the extractor result', async () => {
    // Parser correctness is checked separately; this checks the UI/storage contract
    // with a deterministic extractor and no downloaded PDF/DOCX code.
    for (const [format, mime, signature] of [['pdf', 'application/pdf', '%PDF-1.7\nPDF_UI_FIXTURE'], ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'PK\u0003\u0004DOCX_UI_FIXTURE']]) {
      const { page, context } = await pageFor({ online: true, auth: true });
      await page.evaluate(text => {
        window.__extractionCalls = [];
        extractInterviewFile = async (file, options) => {
          window.__extractionCalls.push({ name: file.name, maxBytes: options.maxBytes, maxPages: options.maxPages, maxChars: options.maxChars });
          return { text, format: file.name.split('.').at(-1), fileName: file.name, fileSize: file.size, pageCount: 1, warnings: [] };
        };
      }, INTERVIEW_SOURCE);
      await page.click('#t4');
      await page.selectOption('#interview-member', seed[0].id);
      await page.setInputFiles('#interview-file', { name: `원본검증.${format}`, mimeType: mime, buffer: Buffer.from(signature) });
      await page.click('#interview-upload');
      await page.waitForFunction(() => window.__db.interviews.some(row => row.raw_text.includes('PRIVATE_INTERVIEW_SOURCE')));
      const saved = await page.evaluate(async () => {
        const row = window.__db.interviews[0], original = window.__db.storageObjects[`member-interviews/${row.storage_path}`];
        return { name: row.original_name, type: original.type, body: await original.body.text(), calls: window.__extractionCalls };
      });
      assert.equal(saved.name, `원본검증.${format}`);
      assert.equal(saved.type, mime);
      assert.equal(saved.body, signature);
      assert.equal(saved.calls.length, 1);
      assert.equal(saved.calls[0].maxPages, 60);
      assert.equal(saved.calls[0].maxChars, 120000);
      assert.equal(await page.inputValue('#interview-raw'), INTERVIEW_SOURCE);
      await context.close();
    }
  });
  await check('AI proposals remain unchecked until review; only selected fields commit after the server response', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    const id = await uploadInterview(page);
    await analyzeInterview(page);
    assert(await page.locator('#interview-review .interview-check').evaluateAll(inputs => inputs.every(input => !input.checked)), 'Suggested values must not be automatically selected for publication.');
    assert.deepEqual(await page.evaluate(() => M[0].c), seed[0].customers);
    const customers = page.locator('#interview-review [data-field="customers"]');
    assert.match(await customers.innerText(), new RegExp(seed[0].customers[0]));
    assert(await customers.locator('.interview-reason').innerText());
    await customers.locator('.interview-check').check();
    await page.locator('#interview-review [data-field="good_referral"] .interview-check').check();
    assert(await page.locator('#interview-apply').isDisabled(), 'Publishing requires an explicit public-data review confirmation.');
    await page.check('#interview-confirm');
    await page.evaluate(() => { window.__db.holdWrites = true; window.__db.holdRpcName = 'apply_member_interview'; });
    await page.click('#interview-apply');
    await page.waitForFunction(() => window.__db.pending.length > 0 && window.__db.log.some(row => row.name === 'apply_member_interview'));
    assert.deepEqual(await page.evaluate(() => M[0].c), seed[0].customers);
    assert.notEqual(await page.evaluate(id => window.__db.interviews.find(row => row.id === id).status, id), 'applied');
    await page.evaluate(() => window.__db.release());
    await page.waitForFunction(() => M[0].c.includes('지역 소상공인'));
    const request = await page.evaluate(() => window.__db.log.find(row => row.name === 'apply_member_interview').value);
    assert.deepEqual(Object.keys(request.public_patch).sort(), ['customers']);
    assert.deepEqual(Object.keys(request.private_patch).sort(), ['good_referral']);
    assert.deepEqual(await page.evaluate(() => M[0].s), seed[0].synergies, 'Unchecked synergy suggestions must remain unchanged.');
    assert.equal(await page.evaluate(memberId => window.__db.details.find(row => row.member_id === memberId).good_referral, seed[0].id), 'INTERVIEW_PRIVATE_REFERRAL 검증 고객');
    assert.equal(await page.evaluate(id => window.__db.interviews.find(row => row.id === id).status, id), 'applied');
    await assertPublicExportPrivate(page);
    await context.close();
  });
  await check('Analysis errors preserve the original and show one actionable message without automatic retries', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await uploadInterview(page);
    const before = await page.evaluate(() => JSON.parse(JSON.stringify(window.__db.interviews[0])));
    await page.evaluate(() => { window.__db.failAnalysis = true; });
    await page.click('#interview-analyze');
    await page.waitForFunction(() => document.getElementById('interview-message').classList.contains('error'));
    assert.equal(await page.locator('#interview-message').innerText(), '분석 결과를 검토안으로 읽지 못했습니다. 원문은 보관되어 있습니다. 오류 코드: analysis_shape');
    assert.deepEqual(await page.evaluate(() => window.__db.interviews[0]), before);
    assert.deepEqual(await page.evaluate(() => window.__db.members[0].customers), seed[0].customers);
    assert.equal(await page.locator('#interview-review .interview-check').count(), 0);
    assert(await page.locator('#interview-analyze').isEnabled());
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.action === 'function' && !item.readOnly).length), 1);
    await context.close();
  });
  await check('Failed or stale interview applies leave both public and private saved data unchanged', async () => {
    for (const failure of ['server', 'stale']) {
      const { page, context } = await pageFor({ online: true, auth: true });
      await uploadInterview(page);
      await analyzeInterview(page);
      await page.locator('#interview-review [data-field="customers"] .interview-check').check();
      await page.locator('#interview-review [data-field="triggers"] .interview-check').check();
      await page.check('#interview-confirm');
      await page.evaluate(failure => {
        if (failure === 'server') { window.__db.failRpc = true; window.__db.failRpcName = 'apply_member_interview'; }
        else window.__db.members[0].updated_at = '2026-10-01T00:00:00.000Z';
      }, failure);
      await page.click('#interview-apply');
      await page.waitForFunction(() => document.getElementById('interview-message').classList.contains('error'));
      assert.deepEqual(await page.evaluate(() => window.__db.members[0].customers), seed[0].customers);
      assert.deepEqual(await page.evaluate(id => window.__db.details.find(row => row.member_id === id).triggers, seed[0].id), [`PRIVATE_TRIGGER_${seed[0].id}`]);
      assert.notEqual(await page.evaluate(() => window.__db.interviews[0].status), 'applied');
      await context.close();
    }
  });
  await check('Realtime roster refresh preserves unsaved interview selections and edited proposals', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await uploadInterview(page);
    await analyzeInterview(page);
    const row = page.locator('#interview-review [data-field="customers"]');
    await row.locator('.interview-value').fill('직접 검토한 공개 고객 유형\n편집 중인 두 번째 유형');
    await row.locator('.interview-check').check();
    const unchecked = page.locator('#interview-review [data-field="synergies"]');
    await unchecked.locator('.interview-value').fill('아직 선택하지 않은 직군 초안');
    assert(!await unchecked.locator('.interview-check').isChecked());
    await page.locator('#admin-note').click();
    const reads = await page.evaluate(() => window.__db.completedAccessReads);
    await page.evaluate(() => { window.__db.members[2].company = '다른 사람의 실시간 수정'; window.__db.realtime(); });
    await page.waitForFunction(reads => window.__db.completedAccessReads > reads, reads);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await row.locator('.interview-value').inputValue(), '직접 검토한 공개 고객 유형\n편집 중인 두 번째 유형');
    assert(await row.locator('.interview-check').isChecked());
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.name === 'apply_member_interview').length), 0);
    await page.click('#interview-save');
    await page.waitForFunction(() => /보관|저장/.test(document.getElementById('interview-message').textContent));
    assert.deepEqual(await page.evaluate(() => M[0].c), seed[0].customers, 'Saving a review draft must not publish it.');
    await page.selectOption('#interview-history', await page.evaluate(() => window.__db.interviews[0].id));
    await page.click('#interview-open');
    await page.waitForFunction(() => /불러왔습니다/.test(document.getElementById('interview-message').textContent));
    assert.equal(await row.locator('.interview-value').inputValue(), '직접 검토한 공개 고객 유형\n편집 중인 두 번째 유형');
    assert(await row.locator('.interview-check').isChecked());
    assert.equal(await unchecked.locator('.interview-value').inputValue(), '아직 선택하지 않은 직군 초안');
    assert(!await unchecked.locator('.interview-check').isChecked(), 'Saving an edited unchecked proposal must not select it for publication.');
    await context.close();
  });
  await check('Saving unchecked review fields and the verification checkbox survives reloading without publication', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    const id = await uploadInterview(page);
    await analyzeInterview(page);
    const customers = page.locator('#interview-review [data-field="customers"] .interview-check');
    const synergies = page.locator('#interview-review [data-field="synergies"] .interview-check');
    const referral = page.locator('#interview-review [data-field="good_referral"] .interview-check');
    await customers.check(); await referral.check(); await page.check('#interview-real');
    await saveInterviewReview(page);
    await reloadInterviewReview(page, id);
    assert(await customers.isChecked()); assert(await referral.isChecked()); assert(await page.isChecked('#interview-real'));
    await customers.uncheck(); await referral.uncheck(); await page.uncheck('#interview-real'); await synergies.check();
    await saveInterviewReview(page);
    const request = await page.evaluate(() => window.__db.log.filter(item => item.name === 'save_member_interview_draft').at(-1).value.draft_patch);
    assert.equal(request.replace_review, true);
    assert.deepEqual(Object.keys(request.public_patch), ['synergies']); assert.deepEqual(request.private_patch, {});
    await reloadInterviewReview(page, id);
    assert(!await customers.isChecked()); assert(!await referral.isChecked()); assert(!await page.isChecked('#interview-real')); assert(await synergies.isChecked());
    await synergies.uncheck(); await saveInterviewReview(page); await reloadInterviewReview(page, id);
    assert(await page.locator('#interview-review .interview-check').evaluateAll(inputs => inputs.every(input => !input.checked)));
    const saved = await page.evaluate(() => window.__db.interviews[0]);
    assert.deepEqual(saved.public_patch, {}); assert.deepEqual(saved.private_patch, {}); assert.equal(saved.raw_text, INTERVIEW_SOURCE);
    assert.deepEqual(await page.evaluate(() => window.__db.members), seed);
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.name === 'apply_member_interview').length), 0);
    await context.close();
  });
  await check('Normalized identical fields show every matching member while similar candidates require explicit confirmation', async () => {
    const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: true, records });
    await page.waitForFunction(() => linksReady);
    const matches = await page.evaluate(() => connectedMembers(M[0], M[0].s[1]).map(member => member.n));
    assert.deepEqual(matches, ['같은 분야 하나', '같은 분야 둘']);
    assert.match(await page.locator('#stage').innerText(), /같은 분야 하나/); assert.match(await page.locator('#stage').innerText(), /같은 분야 둘/);
    assert.equal(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).length), 0);
    await openConnectionReview(page, records[0].id);
    const row = page.locator('.link-row[data-synergy-index="0"]');
    assert.equal(await row.locator('.link-target').inputValue(), ''); assert(await row.locator('.link-save').isDisabled());
    assert.equal(await row.locator('.link-clear').count(), 0);
    assert.match(await row.innerText(), /연결 대상/);
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.name === 'set_member_synergy_link').length), 0);
    assert.deepEqual(await page.evaluate(() => M[0].s), records[0].synergies);
    await context.close();
  });
  await check('Confirmed links update diagrams and gap counts only after success; clearing restores the gap and original wording', async () => {
    const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: true, records });
    await openConnectionReview(page, records[0].id);
    const row = page.locator('.link-row[data-synergy-index="0"]');
    await row.locator('.link-target').selectOption(records[1].id);
    await page.evaluate(() => { window.__db.holdWrites = true; window.__db.holdRpcName = 'set_member_synergy_link'; });
    await row.locator('.link-save').click();
    await page.waitForFunction(() => window.__db.pending.length > 0);
    assert.equal(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).length), 0);
    assert.equal(await page.evaluate(() => teams()['기업'].gaps['홈페이지 제작']), 1);
    assert.equal(await page.evaluate(() => window.__db.links.length), 0);
    await page.evaluate(() => window.__db.release());
    await page.waitForFunction(() => !busy && connectedMembers(M[0], M[0].s[0]).length === 1);
    assert.deepEqual(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).map(member => member.id)), [records[1].id]);
    assert.equal(await page.evaluate(() => teams()['기업'].gaps['홈페이지 제작'] ?? 0), 0);
    assert(!await page.evaluate(() => eureka().some(item => item.f === '홈페이지 제작')));
    const saved = await page.evaluate(() => window.__db.log.find(item => item.name === 'set_member_synergy_link').value);
    assert.deepEqual(saved, { source_member_id: records[0].id, synergy: '홈페이지 제작', target_member_id: records[1].id, expected_member_updated_at: records[0].updated_at, expected_link_updated_at: null });
    assert.deepEqual(await page.evaluate(() => M[0].s), records[0].synergies);
    const stamp = await page.evaluate(() => window.__db.links[0].updated_at);
    await row.locator('.link-clear').click();
    await page.waitForFunction(() => !busy && synergyLinks.length === 0);
    assert.equal(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).length), 0);
    assert.equal(await page.evaluate(() => teams()['기업'].gaps['홈페이지 제작']), 1);
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.name === 'set_member_synergy_link').at(-1).value.expected_link_updated_at), stamp);
    assert.deepEqual(await page.evaluate(() => window.__db.members[0].synergies), records[0].synergies);
    await context.close();
  });
  await check('Failed link writes and stale member/link versions preserve the stored confirmation', async () => {
    for (const failure of ['server', 'member', 'link']) {
      const records = connectionFixtures(), original = { source_member_id: records[0].id, synergy: records[0].synergies[0], target_member_id: records[1].id, updated_at: '2026-09-21T01:00:00.000Z' };
      const { page, context } = await pageFor({ online: true, auth: true, records, links: [original] });
      await openConnectionReview(page, records[0].id);
      const row = page.locator('.link-row[data-synergy-index="0"]');
      await row.locator('.link-target').selectOption(records[2].id);
      const reads = await page.evaluate(() => window.__db.completedReads);
      await page.evaluate(failure => {
        if (failure === 'server') { window.__db.failRpc = true; window.__db.failRpcName = 'set_member_synergy_link'; }
        else if (failure === 'member') window.__db.members[0].updated_at = '2026-10-01T00:00:00.000Z';
        else window.__db.links[0].updated_at = '2026-10-01T00:00:00.000Z';
        window.__db.realtime();
      }, failure);
      await page.locator('#link-review-note').click();
      await page.waitForFunction(reads => window.__db.completedReads >= reads + 2 && !pendingRefresh, reads);
      assert.equal(await row.locator('.link-target').inputValue(), records[2].id, 'A background refresh after blur must retain the unsaved target selection.');
      assert(await row.locator('.link-save').isEnabled());
      await row.locator('.link-save').click();
      await page.waitForFunction(() => !busy && document.getElementById('link-review-message').classList.contains('error'));
      const sent = await page.evaluate(() => window.__db.log.filter(item => item.name === 'set_member_synergy_link').at(-1).value);
      assert.equal(sent.expected_member_updated_at, records[0].updated_at, 'A preserved draft must retain the member version originally reviewed.');
      assert.equal(sent.expected_link_updated_at, original.updated_at, 'A preserved draft must retain the link version originally reviewed.');
      assert.equal(await row.locator('.link-target').inputValue(), failure === 'server' ? records[2].id : records[1].id, 'Ordinary failure retains a draft; stale-version conflicts require a fresh choice.');
      assert.equal(await page.evaluate(() => window.__db.links[0].target_member_id), records[1].id);
      assert.deepEqual(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).map(member => member.id)), [records[1].id]);
      assert.deepEqual(await page.evaluate(() => window.__db.members[0].synergies), records[0].synergies);
      await context.close();
    }
  });
  await check('Public readers receive confirmed-link realtime updates but cannot operate the administrator editor', async () => {
    for (const role of ['anonymous', 'viewer', 'member']) {
      const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: role !== 'anonymous', role, records });
      await page.click('#t4'); assert(await page.locator('#link-review-panel').isHidden());
      await page.evaluate(() => saveSynergyLink(M[0], M[0].s[0], M[1].id, null));
      assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.name === 'set_member_synergy_link').length), 0);
      await page.evaluate(() => { window.__db.links = [{ source_member_id: M[0].id, synergy: M[0].s[0], target_member_id: M[1].id, updated_at: '2026-09-21T02:00:00.000Z' }]; window.__db.realtime(); });
      await page.waitForFunction(() => connectedMembers(M[0], M[0].s[0])[0]?.id === M[1].id);
      assert.equal(await page.evaluate(() => teams()['기업'].gaps['홈페이지 제작'] ?? 0), 0);
      await page.click('#t1'); assert.match(await page.locator('#stage').innerText(), /연결 대상/);
      await context.close();
    }
  });
  await check('Link lookup failure preserves the online roster and exposes a dedicated warning', async () => {
    const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: true, records, failLinkReads: true });
    assert.equal(await page.evaluate(() => online), true); assert.equal(await page.evaluate(() => linksReady), false);
    assert.equal(await page.evaluate(() => M.length), records.length); assert(await page.locator('#connection-badge').isHidden());
    assert(await page.locator('#link-read-warning').isVisible());
    assert.match(await page.locator('#link-read-warning').innerText(), /연결|다시/);
    await page.click('#t4'); assert(await page.locator('#link-member').isDisabled());
    assert(await page.locator('#link-retry').isVisible());
    await page.evaluate(() => { window.__db.failLinkReads = false; }); await page.click('#link-retry');
    await page.waitForFunction(() => linksReady && !connecting);
    assert(await page.locator('#link-read-warning').isHidden()); assert(await page.locator('#link-member').isEnabled());
    await context.close();
  });
  await check('A successful link save with a failed refresh reports saved-but-unconfirmed until retry retrieves it', async () => {
    const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: true, records });
    await openConnectionReview(page, records[0].id);
    const row = page.locator('.link-row[data-synergy-index="0"]');
    await row.locator('.link-target').selectOption(records[1].id);
    await page.evaluate(() => { window.__db.failLinkReads = true; });
    await row.locator('.link-save').click();
    await page.waitForFunction(() => !busy && window.__db.links.length === 1 && !linksReady);
    assert.equal(await page.evaluate(() => online), true);
    assert.equal(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).length), 0);
    assert.match(await page.locator('#link-review-message').innerText(), /저장.*완료.*최신.*불러오지/);
    assert(await page.locator('#link-review-message').evaluate(element => element.classList.contains('error')));
    await page.evaluate(() => { window.__db.failLinkReads = false; }); await page.click('#link-retry');
    await page.waitForFunction(() => linksReady && !connecting && connectedMembers(M[0], M[0].s[0])[0]?.id === M[1].id);
    assert.equal(await page.evaluate(() => window.__db.log.filter(item => item.name === 'set_member_synergy_link').length), 1);
    await context.close();
  });
  await check('Losing administrator access during a pending link write cannot save or restore the editor', async () => {
    const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: true, records });
    await openConnectionReview(page, records[0].id);
    const row = page.locator('.link-row[data-synergy-index="0"]');
    await row.locator('.link-target').selectOption(records[1].id);
    await page.evaluate(() => { window.__db.holdWrites = true; window.__db.holdRpcName = 'set_member_synergy_link'; });
    await row.locator('.link-save').click(); await page.waitForFunction(() => window.__db.pending.length > 0);
    await page.evaluate(() => { window.__db.accounts.find(row => row.user_id === 'test-user').role = 'viewer'; window.__db.setSession(window.__db.session, 'TOKEN_REFRESHED'); });
    await page.waitForFunction(() => document.getElementById('link-review-panel').hidden);
    await page.evaluate(() => window.__db.release()); await page.waitForFunction(() => !busy);
    assert.equal(await page.evaluate(() => window.__db.links.length), 0); assert(await page.locator('#link-review-panel').isHidden());
    assert.equal(await page.evaluate(() => connectedMembers(M[0], M[0].s[0]).length), 0);
    await context.close();
  });
  await check('Mobile member selection searches name company and field, preserves UUID through reorder, and keeps desktop rows', async () => {
    const records = connectionFixtures(), { page, context } = await pageFor({ online: true, auth: true, records });
    await page.click('#t4'); assert.equal(await page.locator('#admintable tbody tr:visible').count(), 1);
    for (const term of [records[2].name, records[2].company, records[2].field]) {
      await page.fill('#admin-member-search', term);
      assert(await page.locator(`#admin-member-select option[value="${records[2].id}"]`).count());
    }
    await page.selectOption('#admin-member-select', records[2].id);
    assert.equal(await page.locator('#admintable tbody tr:visible').getAttribute('data-member-key'), records[2].id);
    await page.evaluate(id => { const member = window.__db.members.find(row => row.id === id); member.name = '이름이 바뀐 멤버'; member.sort_order = -10; window.__db.realtime(); }, records[2].id);
    await page.locator('#admin-note').click();
    await page.waitForFunction(id => M[0].id === id && M[0].n === '이름이 바뀐 멤버', records[2].id);
    assert.equal(await page.inputValue('#admin-member-select'), records[2].id);
    assert.equal(await page.locator('#admintable tbody tr:visible').getAttribute('data-member-key'), records[2].id);
    await page.fill('#admin-member-search', '없는 사람 검색'); assert.equal(await page.locator('#admintable tbody tr:visible').count(), 0);
    assert.match(await page.locator('#admin-member-status').innerText(), /검색 결과가 없습니다/);
    await page.fill('#admin-member-search', ''); await page.setViewportSize({ width: 1440, height: 1000 });
    assert.equal(await page.locator('#admintable tbody tr:visible').count(), records.length);
    await context.close();
  });
  await check('Mobile add and delete select the successful row while own-member navigation clears searches', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    await page.click('#t4'); const original = await page.inputValue('#admin-member-select');
    await page.evaluate(() => { window.__db.holdWrites = true; }); await page.click('#newrow');
    await page.waitForFunction(() => window.__db.pending.length > 0);
    assert.equal(await page.inputValue('#admin-member-select'), original);
    await page.evaluate(() => window.__db.release());
    await page.waitForFunction(() => !busy && M.length === window.__db.members.length && M.length === 32);
    const added = await page.evaluate(() => window.__db.members.at(-1).id);
    await page.waitForFunction(id => document.getElementById('admin-member-select').value === id, added);
    await page.locator('#admintable tbody tr:visible .del').click();
    await page.waitForFunction(() => !busy && M.length === 31);
    assert.notEqual(await page.inputValue('#admin-member-select'), added); assert.equal(await page.locator('#admintable tbody tr:visible').count(), 1);
    await context.close();
    const member = await pageFor({ online: true, auth: true, role: 'member' });
    await member.page.click('#t4'); await member.page.fill('#admin-member-search', '없는 이름'); await member.page.click('#own-memberb');
    assert.equal(await member.page.inputValue('#admin-member-search'), ''); assert.equal(await member.page.inputValue('#admin-member-select'), seed[0].id);
    assert.equal(await member.page.locator('#admintable tbody tr:visible').count(), 1);
    assert(await member.page.locator('#admintable tbody tr:visible input').evaluateAll(inputs => inputs.every(input => !input.readOnly)));
    await member.context.close();
  });
  await check('Losing administrator access clears private review state and discards late AI responses', async () => {
    for (const loss of ['role', 'session']) {
      const { page, context } = await pageFor({ online: true, auth: true });
      await uploadInterview(page);
      await page.evaluate(() => { window.__db.holdAnalysis = true; });
      await page.click('#interview-analyze');
      await page.waitForFunction(() => window.__db.pendingAnalysis.length > 0);
      await page.evaluate(loss => {
        if (loss === 'session') window.__db.setSession(null);
        else { window.__db.accounts.find(row => row.user_id === 'test-user').role = 'viewer'; window.__db.setSession(window.__db.session, 'TOKEN_REFRESHED'); }
      }, loss);
      await page.waitForFunction(() => document.getElementById('interview-panel').hidden);
      await page.evaluate(async () => { window.__db.releaseAnalysis(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
      assert.equal(await page.inputValue('#interview-raw'), '');
      assert.equal(await page.inputValue('#interview-file'), '');
      assert(!/PRIVATE_|INTERVIEW_PRIVATE_/.test(await page.locator('#interview-review').innerHTML()));
      assert.equal(await page.evaluate(() => window.__db.log.filter(row => row.name === 'apply_member_interview').length), 0);
      await assertPublicExportPrivate(page);
      await context.close();
    }
  });
  await check('Late private document reads cannot repopulate the page after logout', async () => {
    const { page, context } = await pageFor({ online: true, auth: true });
    const id = await uploadInterview(page);
    await page.selectOption('#interview-history', id);
    await page.evaluate(() => { window.__db.holdPrivateReads = true; });
    await page.click('#interview-open');
    await page.waitForFunction(() => window.__db.pendingPrivateReads.length > 0);
    await page.evaluate(() => window.__db.setSession(null));
    await page.waitForFunction(() => document.getElementById('interview-panel').hidden);
    await page.evaluate(async () => { window.__db.releasePrivateReads(); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    assert.equal(await page.inputValue('#interview-raw'), '');
    assert(!/PRIVATE_|INTERVIEW_PRIVATE_/.test(await page.locator('#interview-review').innerHTML()));
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
    for (const viewport of [{ label: '400', width: 400, height: 900 }, { label: 'desktop', width: 1440, height: 1000 }]) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        for (const view of ['v1', 'v2', 'v3', 'v4']) {
          await page.click(`#t${view.slice(1)}`);
          await page.evaluate(() => scrollTo(0, 0));
          const name = `browser-${viewport.label}-${theme}-${view}.png`;
          await page.screenshot({ path: path.join(directory, name), fullPage: view !== 'v4', animations: 'disabled' });
          console.log(`SCREENSHOT diagnostics-output/${name}`);
          if (view === 'v4') {
            await page.locator('#admintable').evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().height - 20));
            const rosterName = `browser-${viewport.label}-${theme}-v4-roster.png`;
            await page.screenshot({ path: path.join(directory, rosterName), animations: 'disabled' });
            console.log(`SCREENSHOT diagnostics-output/${rosterName}`);
          }
        }
      }
    }
    await page.setViewportSize({ width: 400, height: 900 });
    await page.click('#t4');
    await page.selectOption('#admin-member-select', seed[0].id);
    const reviewCandidate = await page.evaluate(() => {
      for (const member of M) {
        const index = syn(member).findIndex(field => !connectedMembers(member, field).length && synergyCandidates(member, field).length);
        if (index >= 0) return { memberId: member.id, index };
      }
      return { memberId: M[0].id, index: 0 };
    });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.locator('.admin-member-picker').evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().height - 20));
      const pickerName = `browser-400-${theme}-member-picker.png`;
      await page.screenshot({ path: path.join(directory, pickerName), animations: 'disabled' });
      console.log(`SCREENSHOT diagnostics-output/${pickerName}`);
      await openConnectionReview(page, reviewCandidate.memberId);
      await page.locator(`#link-review-rows .link-row[data-synergy-index="${reviewCandidate.index}"]`).evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().height - 90));
      const linksName = `browser-400-${theme}-link-review.png`;
      await page.screenshot({ path: path.join(directory, linksName), animations: 'disabled' });
      console.log(`SCREENSHOT diagnostics-output/${linksName}`);
    }
    await context.close();
    const reader = await pageFor({ online: true });
    await reader.page.click('#loginb');
    for (const viewport of [{ label: '400', width: 400, height: 900 }, { label: 'desktop', width: 1440, height: 1000 }]) {
      await reader.page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ['light', 'dark']) {
        await reader.page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        for (const mode of ['login', 'signup', 'reset']) {
          await reader.page.click(`#auth-${mode}-mode`);
          const name = `browser-${viewport.label}-${theme}-auth-${mode}.png`;
          await reader.page.screenshot({ path: path.join(directory, name), animations: 'disabled' });
          console.log(`SCREENSHOT diagnostics-output/${name}`);
        }
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
        await content.evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().height - 20));
        const contentName = role === 'admin' ? `browser-400-${theme}-accounts.png` : `browser-400-${theme}-${role}-content.png`;
        await rolePage.page.screenshot({ path: path.join(directory, contentName), animations: 'disabled' });
      }
      await rolePage.page.click('#passwordb');
      await rolePage.page.screenshot({ path: path.join(directory, `browser-400-dark-${role}-password.png`), animations: 'disabled' });
      await rolePage.context.close();
    }
    const interviewPage = await pageFor({ online: true, auth: true });
    await interviewPage.page.click('#t4');
    for (const viewport of [{ label: '400', width: 400, height: 900 }, { label: 'desktop', width: 1440, height: 1000 }]) {
      await interviewPage.page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ['light', 'dark']) {
        await interviewPage.page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await interviewPage.page.locator('#interview-panel').evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().height - 20));
        await interviewPage.page.screenshot({ path: path.join(directory, `browser-${viewport.label}-${theme}-interview-upload.png`), animations: 'disabled' });
      }
    }
    await uploadInterview(interviewPage.page);
    await analyzeInterview(interviewPage.page);
    await interviewPage.page.locator('#interview-review [data-field="customers"] .interview-check').check();
    for (const viewport of [{ label: '400', width: 400, height: 900 }, { label: 'desktop', width: 1440, height: 1000 }]) {
      await interviewPage.page.setViewportSize({ width: viewport.width, height: viewport.height });
      for (const theme of ['light', 'dark']) {
        await interviewPage.page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await interviewPage.page.locator('#interview-review').evaluate(element => scrollTo(0, scrollY + element.getBoundingClientRect().top - document.querySelector('nav').getBoundingClientRect().height - 20));
        const sizes = await interviewPage.page.evaluate(() => ({ width: innerWidth, html: document.documentElement.scrollWidth, body: document.body.scrollWidth }));
        assert(sizes.html <= sizes.width && sizes.body <= sizes.width, `${theme} interview review: ${JSON.stringify(sizes)}`);
        await interviewPage.page.screenshot({ path: path.join(directory, `browser-${viewport.label}-${theme}-interview-review.png`), animations: 'disabled' });
      }
    }
    await interviewPage.context.close();
  }
} finally { await browser.close(); }
