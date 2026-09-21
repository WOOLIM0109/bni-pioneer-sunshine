import { copyFile, lstat, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const siteName = '파이오니아 선샤인';
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const attribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'i'))?.[1];

function replaceOne(source, pattern, replace, label) {
  let count = 0;
  const result = source.replace(pattern, (...args) => { count++; return replace(...args); });
  if (count !== 1) throw new Error(`Expected exactly one ${label}; found ${count}.`);
  return result;
}

function setAttribute(tag, name, value) {
  const pattern = new RegExp(`\\s${name}(?:="[^"]*")?(?=\\s|>)`, 'gi');
  const clean = tag.replace(pattern, '');
  return value == null ? clean : clean.replace(/>$/, ` ${name}="${escapeHtml(value)}">`);
}

function canonicalFromHtml(source) {
  const tags = [...source.matchAll(/<link\b[^>]*>/gi)].map(match => match[0]).filter(tag => attribute(tag, 'rel') === 'canonical');
  if (tags.length !== 1 || !attribute(tags[0], 'href')) throw new Error('Expected one canonical link with an absolute href.');
  return attribute(tags[0], 'href');
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('The site base URL must be an HTTP(S) URL without credentials, query, or hash.');
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

export function routesFromHtml(source) {
  const blocks = [...source.matchAll(/\/\/ PAGE_ROUTES_START\s*([\s\S]*?)\s*\/\/ PAGE_ROUTES_END/g)];
  if (blocks.length !== 1) throw new Error('Expected one PAGE_ROUTES_START / PAGE_ROUTES_END block.');
  const declaration = blocks[0][1].trim().match(/^const PAGE_ROUTES\s*=\s*(\[[\s\S]*\]);?$/);
  if (!declaration) throw new Error('PAGE_ROUTES must be a const declaration containing a JSON array.');
  const routes = JSON.parse(declaration[1]);
  if (!Array.isArray(routes) || !routes.length) throw new Error('PAGE_ROUTES must contain at least one route.');
  const views = new Set(), slugs = new Set();
  for (const route of routes) {
    if (!route || typeof route !== 'object' || !/^v[1-9][0-9]*$/.test(route.view) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(route.slug)
      || ['assets', 'index', '404'].includes(route.slug) || typeof route.title !== 'string' || !route.title.trim() || typeof route.description !== 'string' || !route.description.trim()) {
      throw new Error('Each route needs a valid view, safe slug, title, and description.');
    }
    if (views.has(route.view) || slugs.has(route.slug)) throw new Error('Route views and slugs must be unique.');
    views.add(route.view); slugs.add(route.slug);
  }
  return routes;
}

function replaceMeta(source, kind, key, value) {
  let count = 0;
  const result = source.replace(/<meta\b[^>]*>/gi, tag => {
    if (attribute(tag, kind) !== key) return tag;
    count++;
    return setAttribute(tag, 'content', value);
  });
  if (count !== 1) throw new Error(`Expected exactly one ${key} meta tag; found ${count}.`);
  return result;
}

export function renderPage(source, route, { baseUrl = canonicalFromHtml(source) } = {}) {
  const routes = routesFromHtml(source);
  if (route && !routes.some(item => item.view === route.view && item.slug === route.slug)) throw new Error('Cannot render an undeclared route.');
  const base = normalizeBaseUrl(baseUrl), originalBase = normalizeBaseUrl(canonicalFromHtml(source));
  const pageUrl = new URL(route ? `${route.slug}/` : '', base).href;
  let html = source.replace(/<link\b[^>]*>/gi, tag => attribute(tag, 'rel') === 'canonical' ? setAttribute(tag, 'href', pageUrl) : tag);
  html = replaceMeta(html, 'property', 'og:url', pageUrl);
  if (route) {
    const title = `${route.title} | ${siteName}`;
    html = replaceOne(html, /<title>[\s\S]*?<\/title>/gi, () => `<title>${escapeHtml(title)}</title>`, 'document title');
    for (const [kind, key, value] of [['property', 'og:title', title], ['name', 'twitter:title', title], ['property', 'og:description', route.description], ['name', 'twitter:description', route.description], ['name', 'description', route.description]]) {
      html = replaceMeta(html, kind, key, value);
    }
  }
  // Keep the existing shared image, including when Pages moves to a custom domain.
  html = html.replace(/<meta\b[^>]*>/gi, tag => {
    if (!['og:image', 'twitter:image'].includes(attribute(tag, 'property') || attribute(tag, 'name'))) return tag;
    const image = new URL(attribute(tag, 'content'), originalBase);
    if (image.origin !== originalBase.origin || !image.pathname.startsWith(originalBase.pathname)) return tag;
    return setAttribute(tag, 'content', new URL(image.pathname.slice(originalBase.pathname.length), base).href);
  });
  const activeView = route?.view || routes[0].view;
  const navCounts = new Map(routes.map(item => [item.view, 0]));
  html = html.replace(/<a\b[^>]*>/gi, tag => {
    if (!attribute(tag, 'class')?.split(/\s+/).includes('step')) return tag;
    const target = routes.find(item => item.view === attribute(tag, 'data-v'));
    if (!target) throw new Error('Every step anchor must reference a declared route.');
    navCounts.set(target.view, navCounts.get(target.view) + 1);
    tag = setAttribute(tag, 'href', `${base.pathname}${target.slug}/`);
    tag = setAttribute(tag, 'aria-selected', String(target.view === activeView));
    return setAttribute(tag, 'aria-current', target.view === activeView ? 'page' : null);
  });
  for (const item of routes) {
    if (navCounts.get(item.view) !== 1) throw new Error(`Expected exactly one step anchor for ${item.view}.`);
    html = replaceOne(html, new RegExp(`<section\\b[^>]*\\sid="${item.view}"[^>]*>`, 'gi'), tag => setAttribute(tag, 'hidden', item.view === activeView ? null : ''), `${item.view} section`);
  }
  return html;
}

function notFoundPage(base, routes) {
  return `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>페이지를 찾을 수 없습니다 | ${siteName}</title><style>body{font-family:system-ui,sans-serif;max-width:640px;margin:12vh auto;padding:24px;line-height:1.7;color:#241d21}h1{font-size:28px}a{color:#c8102e}li{margin:12px 0}</style></head><body><h1>페이지를 찾을 수 없습니다</h1><p>주소를 확인하거나 아래 페이지로 이동해 주세요.</p><p><a href="${escapeHtml(base.pathname)}">파이오니아 선샤인 홈</a></p><ul>${routes.map(route => `<li><a href="${escapeHtml(`${base.pathname}${route.slug}/`)}">${escapeHtml(route.title)}</a></li>`).join('')}</ul></body></html>
`;
}

async function copyPublicAssets(from, to) {
  const publicExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.svg', '.ico', '.woff', '.woff2']);
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    if (entry.isSymbolicLink()) throw new Error('Public assets must not contain symbolic links.');
    const source = path.join(from, entry.name), target = path.join(to, entry.name);
    if (entry.isDirectory()) await copyPublicAssets(source, target);
    else if (entry.isFile() && publicExtensions.has(path.extname(entry.name).toLowerCase())) await copyFile(source, target);
  }
}

export async function buildSite({ baseUrl } = {}) {
  const source = await readFile(path.join(root, 'index.html'), 'utf8');
  const routes = routesFromHtml(source), base = normalizeBaseUrl(baseUrl || canonicalFromHtml(source));
  // Render every page before touching output, so source errors leave the last build intact.
  const pages = [null, ...routes].map(route => ({ route, html: renderPage(source, route, { baseUrl: base.href }) }));
  const output = path.resolve(root, '_site');
  if (path.dirname(output) !== path.resolve(root) || path.basename(output) !== '_site') throw new Error('Refusing to clean an output directory outside this repository.');
  const existing = await lstat(output).catch(error => { if (error.code !== 'ENOENT') throw error; return null; });
  if (existing?.isSymbolicLink()) throw new Error('The build output must not be a symbolic link.');
  await rm(output, { recursive: true, force: true });
  for (const { route, html } of pages) {
    const directory = route ? path.join(output, route.slug) : output;
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'index.html'), html, 'utf8');
  }
  await copyPublicAssets(path.join(root, 'assets'), path.join(output, 'assets'));
  await writeFile(path.join(output, '.nojekyll'), '', 'utf8');
  await writeFile(path.join(output, '404.html'), notFoundPage(base, routes), 'utf8');
  return { output, pages: pages.length, baseUrl: base.href };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await buildSite({ baseUrl: process.env.PAGES_BASE_URL });
  console.log(`Built ${result.pages} pages in ${result.output} for ${result.baseUrl}`);
}
