#!/usr/bin/env node
// Run only against this repository's trusted, local index.html.
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';

const args = process.argv.slice(2);
if (args.some(arg => !['--dry-run', '--help'].includes(arg))) {
  console.error('알 수 없는 옵션입니다. node seed/seed.mjs [--dry-run] 형식으로 실행하세요.');
  process.exitCode = 1;
} else if (args.includes('--help')) {
  console.log('사용법: node seed/seed.mjs [--dry-run]\n실제 주입에는 SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY 환경변수가 필요합니다.\n--dry-run은 연결 없이 HTML 시드 31명과 필드 대응을 확인합니다.');
} else {
  try {
    await main(args.includes('--dry-run'));
  } catch (error) {
    const secret = process.env.SUPABASE_SERVICE_ROLE_KEY;
    const message = String(error?.message || error);
    console.error(`시드 주입 중단: ${secret ? message.split(secret).join('[비밀키 숨김]') : message}`);
    process.exitCode = 1;
  }
}

async function main(dryRun) {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const marked = html.match(/\/\/ SEED_MEMBERS_START\s*([\s\S]*?)\/\/ SEED_MEMBERS_END/);
  const declaration = (marked?.[1] || html).match(/(?:let|const)\s+(?:M|SEED_MEMBERS)\s*=\s*(\[[\s\S]*?\n\]);?/);
  if (!declaration) {
    throw new Error('index.html에서 시드 배열을 찾지 못했습니다. SEED_MEMBERS_START/END 사이의 M 배열을 확인하세요.');
  }
  // This intentionally evaluates only the checked-in array, never remote input.
  const members = new Script(`(${declaration[1]})`).runInNewContext(Object.create(null), { timeout: 1000 });
  if (!Array.isArray(members) || members.length !== 31) {
    throw new Error(`최초 시드는 31명이어야 합니다. 현재 ${members?.length ?? '알 수 없는 수'}명입니다. 원본 배열을 확인하세요.`);
  }
  const seenNames = new Set();
  const rows = members.map((member, index) => {
    const requiredText = key => {
      if (typeof member[key] !== 'string') throw new Error(`${index + 1}번째 멤버의 ${key} 값은 문자열이어야 합니다.`);
      return member[key];
    };
    const optionalText = key => {
      if (member[key] == null) return '';
      return requiredText(key);
    };
    const textArray = key => {
      const value = member[key] ?? [];
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`${index + 1}번째 멤버의 ${key} 값은 문자열 배열이어야 합니다.`);
      }
      return Array.from(value);
    };
    const flag = key => {
      if (member[key] == null) return false;
      if (![true, false, 0, 1].includes(member[key])) throw new Error(`${index + 1}번째 멤버의 ${key} 값은 true/false 또는 0/1이어야 합니다.`);
      return Boolean(member[key]);
    };
    const name = requiredText('n').trim();
    if (!name) throw new Error(`${index + 1}번째 멤버의 성함이 비어 있습니다.`);
    if (seenNames.has(name)) throw new Error(`시드에 같은 성함(${name})이 있습니다. 동명이인 여부를 사람이 확인한 후 실행하세요.`);
    seenNames.add(name);
    return {
      name,
      company: requiredText('co'),
      field: requiredText('f'),
      team: requiredText('g') || '미정',
      customers: textArray('c'),
      synergies: textArray('s'),
      wants: optionalText('w'),
      good_referral: optionalText('v'),
      triggers: textArray('tg'),
      is_new: flag('nw'),
      is_real: flag('real'),
      sort_order: index,
    };
  });
  if (dryRun) {
    console.log(`검증 완료: ${rows.length}명, sort_order 0–${rows.length - 1}, 필드 12개. 서버 연결과 데이터 변경은 하지 않았습니다.`);
    return;
  }

  const projectUrl = process.env.SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!projectUrl || !secret) {
    throw new Error('SUPABASE_URL과 SUPABASE_SERVICE_ROLE_KEY 환경변수를 설정하세요. 비밀키를 파일이나 명령 인자로 전달하지 마세요.');
  }
  let url;
  try { url = new URL(projectUrl); } catch { throw new Error('SUPABASE_URL이 올바른 주소가 아닙니다. 프로젝트의 https:// 주소를 확인하세요.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) {
    throw new Error('SUPABASE_URL에는 사용자 정보나 경로가 없는 프로젝트 HTTPS 주소만 설정하세요.');
  }
  const endpoint = new URL('/rest/v1/members', url);
  const headers = { apikey: secret, Authorization: `Bearer ${secret}` };
  const existingUrl = new URL(endpoint);
  existingUrl.search = '?select=id&limit=1';
  const existing = await request(existingUrl, { headers });
  if (!Array.isArray(existing)) throw new Error('members 조회 응답이 배열이 아닙니다. 프로젝트 URL과 테이블을 확인하세요.');
  if (existing.length) {
    throw new Error('members에 이미 데이터가 있어 삽입하지 않았습니다. 이 스크립트는 빈 테이블에 최초 1회만 실행하세요.');
  }
  const inserted = await request(endpoint, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json', Prefer: 'return=representation' },
    body: JSON.stringify(rows),
  });
  if (!Array.isArray(inserted) || inserted.length !== rows.length) {
    throw new Error('삽입 응답의 행 수를 확인할 수 없습니다. 다시 실행하기 전에 Supabase Table Editor에서 데이터를 확인하세요.');
  }
  console.log(`주입 완료: ${inserted.length}명. 원래 배열 순서대로 sort_order 0–${rows.length - 1}을 저장했습니다.`);
}

async function request(url, options) {
  let response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new Error('Supabase 요청이 실패하거나 20초를 초과했습니다. 연결과 프로젝트 상태를 확인하고, 삽입 시도 후라면 Table Editor에서 성공 여부부터 확인하세요.');
  }
  let data;
  try { data = await response.json(); } catch { throw new Error(`서버 응답을 읽지 못했습니다(HTTP ${response.status}). URL과 프로젝트 상태를 확인하세요.`); }
  if (!response.ok) {
    const detail = [data?.message, data?.hint].filter(item => typeof item === 'string').join(' ').slice(0, 800);
    throw new Error(`Supabase HTTP ${response.status}: ${detail || '요청이 거절되었습니다.'} 스키마 실행 여부와 환경변수의 프로젝트·비밀키를 확인하세요.`);
  }
  return data;
}
