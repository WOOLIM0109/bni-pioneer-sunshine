import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { buildSite, renderPage, routesFromHtml, renderLegacyTeamRedirect } from '../scripts/build-pages.mjs';
import vm from 'node:vm';

const source = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const routes = routesFromHtml(source);
assert.deepEqual(routes.map(route => route.slug), ['sunshine', 'collab-teams', 'members']);
const getAttribute = (tag, name) => tag.match(new RegExp(`\\s${name}="([^"]*)"`))?.[1];
const meta = (html, name) => [...html.matchAll(/<meta\b[^>]*>/g)].map(match => match[0]).find(tag => getAttribute(tag, 'name') === name || getAttribute(tag, 'property') === name);

for (const baseUrl of ['https://woolim0109.github.io/bni-pioneer-sunshine/', 'https://sunshine.bni-pioneer.com/', 'http://localhost:43127/']) {
  const redirect = renderLegacyTeamRedirect(baseUrl);
  const redirectScript = redirect.match(/<script>([\s\S]*?)<\/script>/)[1];
  let destination;
  vm.runInNewContext(redirectScript, { location: { search: '?from=old', hash: '#type=recovery&access_token=fixture', replace: value => { destination = value; } } });
  assert.equal(destination, new URL('collab-teams/', baseUrl).href + '?from=old#type=recovery&access_token=fixture');
  assert(redirect.includes('noindex'));
  for (const route of [null, ...routes]) {
    const html = renderPage(source, route, { baseUrl });
    assert.doesNotMatch(html, /(?:id|data-v|aria-controls)="[vt]3"/);
    assert.doesNotMatch(html, /챕터(?: 전체)? 지도|renderChapter|collab-operations/);
    const expectedUrl = new URL(route ? `${route.slug}/` : '', baseUrl).href;
    assert.equal(getAttribute(html.match(/<link\b[^>]*rel="canonical"[^>]*>/)[0], 'href'), expectedUrl);
    assert.equal(getAttribute(meta(html, 'og:url'), 'content'), expectedUrl);
    assert.equal(getAttribute(meta(html, 'og:image'), 'content'), new URL('assets/pioneer-sunshine-share.png', baseUrl).href);
    assert.equal(getAttribute(meta(html, 'twitter:image'), 'content'), new URL('assets/pioneer-sunshine-share.png', baseUrl).href);
    const expectedView = route?.view || routes[0].view;
    for (const target of routes) {
      const section = html.match(new RegExp(`<section\\b[^>]*\\sid="${target.view}"[^>]*>`))[0];
      assert.equal(/\shidden(?:=|\s|>)/.test(section), target.view !== expectedView, `${expectedUrl}: initial visibility of ${target.view}`);
      const anchor = [...html.matchAll(/<a\b[^>]*>/g)].map(match => match[0]).find(tag => getAttribute(tag, 'data-v') === target.view);
      assert.ok(anchor, `${target.view} has a native navigation link`);
      assert.equal(getAttribute(anchor, 'href'), `${new URL(baseUrl).pathname}${target.slug}/`);
      assert.equal(getAttribute(anchor, 'aria-selected'), String(target.view === expectedView));
      assert.equal(getAttribute(anchor, 'aria-current'), target.view === expectedView ? 'page' : undefined);
    }
    if (route) {
      const title = `${route.title} | 파이오니아 선샤인`;
      assert.equal(html.match(/<title>(.*?)<\/title>/)[1], title);
      for (const name of ['og:title', 'twitter:title']) assert.equal(getAttribute(meta(html, name), 'content'), title);
      for (const name of ['description', 'og:description', 'twitter:description']) assert.equal(getAttribute(meta(html, name), 'content'), route.description);
    } else {
      assert.equal(html.match(/<title>(.*?)<\/title>/)[1], source.match(/<title>(.*?)<\/title>/)[1]);
      assert.equal(getAttribute(meta(html, 'og:description'), 'content'), getAttribute(meta(source, 'og:description'), 'content'));
    }
    assert.deepEqual(routesFromHtml(html), routes, 'Build leaves the runtime route data unchanged.');
  }
}

const replaceRoutes = data => source.replace(/\/\/ PAGE_ROUTES_START[\s\S]*?\/\/ PAGE_ROUTES_END/, `// PAGE_ROUTES_START\nconst PAGE_ROUTES = ${JSON.stringify(data)};\n// PAGE_ROUTES_END`);
assert.throws(() => routesFromHtml(source.replace('// PAGE_ROUTES_START', '// MISSING_ROUTES_START')), /Expected one PAGE_ROUTES/);
assert.throws(() => routesFromHtml(replaceRoutes([...routes, routes[0]])), /must be unique/);
assert.throws(() => routesFromHtml(replaceRoutes([{ ...routes[0], slug: '../private' }])), /safe slug/);
assert.throws(() => renderPage(source.replace('data-v="v4"', 'data-v="missing"'), routes[0]), /declared route/);
assert.throws(() => renderPage(source.replace('<section id="v2"', '<section id="missing"'), routes[0]), /v2 section/);
assert.throws(() => renderPage(source, routes[0], { baseUrl: 'https://example.test/?token=secret' }), /base URL/);
assert.throws(() => renderPage(source, { ...routes[0], slug: 'missing' }), /undeclared route/);

const escapedRoutes = routes.map((route, index) => index ? route : { ...route, title: '고객 & "성장" <모임>', description: 'A & B의 "공유" <페이지>' });
const escapedHtml = renderPage(replaceRoutes(escapedRoutes), escapedRoutes[0]);
assert.ok(escapedHtml.includes('<title>고객 &amp; &quot;성장&quot; &lt;모임&gt; | 파이오니아 선샤인</title>'));
assert.equal(getAttribute(meta(escapedHtml, 'og:description'), 'content'), 'A &amp; B의 &quot;공유&quot; &lt;페이지&gt;');
const built = await buildSite();
assert.equal(built.pages, 4, 'Only home and the three remaining screens are built as application pages.');
for (const slug of ['power-teams', 'chapter-map']) {
  const redirect = await readFile(`${built.output}/${slug}/index.html`, 'utf8');
  assert.equal(redirect, renderLegacyTeamRedirect(built.baseUrl), `${slug} is emitted as a redirect, not an application page.`);
}
const notFound = await readFile(`${built.output}/404.html`, 'utf8');
assert.doesNotMatch(notFound, /chapter-map|챕터 전체 지도/);
console.log(`Page build checks passed: ${routes.length} routes, home, both legacy redirects, metadata, native links, base paths, and invalid source rejection.`);
