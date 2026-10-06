import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const baseUrl = process.env.SEO_TEST_URL ?? 'http://127.0.0.1:4321';
const compareBaseUrl = process.env.SEO_COMPARE_URL;
const outputDir = resolve(process.argv[2] ?? 'test-results/seo-current');
const compareOutputDir = resolve(process.env.SEO_COMPARE_OUTPUT ?? join(outputDir, 'baseline'));
const settleMs = Number(process.env.SEO_SETTLE_MS ?? 250);
const port = Number(process.env.SEO_CDP_PORT ?? 9300 + Math.floor(Math.random() * 500));
const routes = [
  { path: '/', name: 'home' },
  { path: '/about/', name: 'about' },
  { path: '/services/', name: 'services' },
  { path: '/pricing/', name: 'pricing' },
  { path: '/contact/', name: 'contact' },
  { path: '/privacy/', name: 'privacy' },
];
const selectedRoutes = process.env.SEO_TEST_ROUTES
  ? routes.filter(({ path, name }) => process.env.SEO_TEST_ROUTES.split(',').includes(path) || process.env.SEO_TEST_ROUTES.split(',').includes(name))
  : routes;
const viewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const selectedViewports = process.env.SEO_TEST_VIEWPORTS
  ? viewports.filter(({ width, height }) => process.env.SEO_TEST_VIEWPORTS.split(',').includes(`${width}x${height}`))
  : viewports;
const failures = [];
const report = { captures: [], comparisons: [], interactions: {}, functional: {} };

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
const fail = (message) => failures.push(message);
const browserCandidates = [
  process.env.BROWSER_PATH,
  process.env.EDGE_PATH,
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Microsoft/Edge/Application/msedge.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Microsoft/Edge/Application/msedge.exe'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft/Edge/Application/msedge.exe'),
  process.env.PROGRAMFILES && join(process.env.PROGRAMFILES, 'Google/Chrome/Application/chrome.exe'),
  process.env['PROGRAMFILES(X86)'] && join(process.env['PROGRAMFILES(X86)'], 'Google/Chrome/Application/chrome.exe'),
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browserPath = browserCandidates.find(existsSync);
if (!browserPath) throw new Error('No supported Edge/Chrome executable found. Set BROWSER_PATH to an installed Chromium browser.');

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ws.addEventListener('message', ({ data }) => {
      const message = JSON.parse(data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (pending) {
          this.pending.delete(message.id);
          message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result);
        }
      } else this.events.push(message);
    });
  }
  async open() {
    await new Promise((resolveOpen, reject) => {
      this.ws.addEventListener('open', resolveOpen, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const request = { id, method, params };
    if (sessionId) request.sessionId = sessionId;
    this.ws.send(JSON.stringify(request));
    return new Promise((resolveSend, reject) => this.pending.set(id, { resolve: resolveSend, reject }));
  }
  async waitFor(method, sessionId, timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const index = this.events.findIndex((event) => event.method === method && (!sessionId || event.sessionId === sessionId));
      if (index >= 0) return this.events.splice(index, 1)[0];
      await sleep(20);
    }
    throw new Error(`Timed out waiting for ${method}`);
  }
  takeEvents(method, sessionId) {
    const matches = [];
    this.events = this.events.filter((event) => {
      if (event.method === method && (!sessionId || event.sessionId === sessionId)) {
        matches.push(event);
        return false;
      }
      return true;
    });
    return matches;
  }
}

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(50);
  }
  throw new Error('Chromium remote-debugging endpoint did not start.');
}

const stableSource = ({ accepted = true, mockMap = true, storageThrows = false } = {}) => `
  (() => {
    ${storageThrows ? `
      Storage.prototype.getItem = function () { throw new DOMException('Storage denied', 'SecurityError'); };
      Storage.prototype.setItem = function () { throw new DOMException('Storage denied', 'SecurityError'); };
    ` : `
      try { ${accepted ? "localStorage.setItem('cookiesAccepted', 'true');" : "localStorage.removeItem('cookiesAccepted');"} } catch {}
    `}
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important;caret-color:transparent!important;will-change:auto!important}';
      document.head.append(style);
      ${mockMap ? `
        const frame = document.querySelector('iframe[title="Mapa lokalizacji gabinetu Logorytm"]');
        if (frame) {
          frame.removeAttribute('src'); frame.removeAttribute('data-map-src');
          frame.srcdoc = '<!doctype html><style>html,body{margin:0;height:100%;background:#f3f4f6}</style>';
        }
      ` : ''}
    }, { once: true });
  })();
`;

async function createSession(cdp, source = '') {
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  if (source) await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source }, sessionId);
  return { targetId, sessionId };
}
async function setViewport(cdp, sessionId, { width, height }) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height }, sessionId);
}
async function navigate(cdp, sessionId, url) {
  await cdp.send('Page.navigate', { url }, sessionId);
  await cdp.waitFor('Page.loadEventFired', sessionId);
  await cdp.send('Runtime.evaluate', { expression: 'document.fonts.ready', awaitPromise: true }, sessionId);
  await sleep(settleMs);
}
async function scrollThroughPage(cdp, sessionId) {
  await cdp.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      let y = 0; const step = Math.max(200, Math.floor(innerHeight * 0.75));
      const next = () => { y = Math.min(y + step, document.documentElement.scrollHeight); scrollTo(0, y);
        if (y >= document.documentElement.scrollHeight - innerHeight) requestAnimationFrame(() => requestAnimationFrame(resolve));
        else requestAnimationFrame(next); };
      next();
    })`, awaitPromise: true,
  }, sessionId);
  await cdp.send('Runtime.evaluate', { expression: 'scrollTo(0, 0)' }, sessionId);
  await cdp.send('Runtime.evaluate', {
    expression: `(() => {
      document.querySelectorAll('.reveal-up,.reveal-left,.reveal-right').forEach((element) => element.classList.add('active'));
      const decoded = Promise.all([...document.images].map((image) => image.complete
        ? image.decode?.().catch(() => {})
        : new Promise((resolve) => { image.addEventListener('load', resolve, { once: true }); image.addEventListener('error', resolve, { once: true }); })));
      return Promise.race([decoded, new Promise((resolve) => setTimeout(resolve, 3000))]);
    })()`,
    awaitPromise: true,
  }, sessionId);
  await sleep(100);
}

const snapshotExpression = (route) => `(() => {
  const route = ${JSON.stringify(route)};
  const classValue = (element) => typeof element.className === 'string' ? element.className : (element.className?.baseVal ?? '');
  const nodes = [...document.body.querySelectorAll('*')].map((element) => {
    const rect = element.getBoundingClientRect(); const style = getComputedStyle(element);
    return { tag: element.tagName.toLowerCase(), id: element.id, className: classValue(element),
      text: (element.textContent ?? '').replace(/\\s+/g, ' ').trim().slice(0, 120),
      rect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
      style: { display: style.display, position: style.position, fontFamily: style.fontFamily, fontSize: style.fontSize,
        fontWeight: style.fontWeight, lineHeight: style.lineHeight, letterSpacing: style.letterSpacing, color: style.color,
        backgroundColor: style.backgroundColor, borderRadius: style.borderRadius, objectFit: style.objectFit, objectPosition: style.objectPosition } };
  });
  const sections = [...document.querySelectorAll('main section')]; const changed = [];
  const add = (label, element) => { if (!element) return; const rect = element.getBoundingClientRect();
    changed.push({ label, x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height }); };
  if (route === '/') {
    add('home hero paragraph', sections[0]?.querySelector('.hero-reveal-left > p'));
    add('home supporting methods description', [...(sections[2]?.querySelectorAll('p') ?? [])].find((p) => p.classList.contains('text-white/80')));
    add('home local paragraph', sections[4]?.querySelector('.space-y-6 p:nth-child(2)'));
  } else if (route === '/about/') add('about hero paragraph', sections[0]?.querySelector('.space-y-6 p:nth-child(2)'));
  else if (route === '/services/') {
    add('services hero paragraph', sections[0]?.querySelector('h1 + p'));
    const descriptions = [...(sections[1]?.querySelectorAll('p') ?? [])].filter((element) => element.classList.contains('text-lg'));
    ['diagnoza', 'terapia', 'nauka-czytania', 'elektrostymulacja'].forEach((id, index) => add('service ' + id + ' description', descriptions[index]));
  } else if (route === '/pricing/') {
    add('pricing hero paragraph', sections[0]?.querySelector('h1 + p'));
    add('pricing electrostimulation package description', sections[2]?.querySelector('.grid > div:nth-child(3) p'));
  } else if (route === '/privacy/') {
    const items = [...document.querySelectorAll('main li')];
    add('privacy map connection', items.find((item) => item.textContent.includes('mapa Google Maps') && item.textContent.includes('serwerami Google')));
    add('privacy storage choice', items.find((item) => item.textContent.includes('pamięci lokalnej przeglądarki') && item.textContent.includes('cookiesAccepted')));
    add('privacy map cookies', items.find((item) => item.textContent.includes('mapa Google Maps') && item.textContent.includes('plików cookie')));
  }
  return { nodes, changed, body: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight } };
})()`;

async function capturePage(cdp, sessionId, base, route, viewport, directory) {
  await setViewport(cdp, sessionId, viewport); await navigate(cdp, sessionId, `${base}${route.path}`); await scrollThroughPage(cdp, sessionId);
  const snapshot = (await cdp.send('Runtime.evaluate', { expression: snapshotExpression(route.path), returnByValue: true }, sessionId)).result.value;
  const metrics = await cdp.send('Page.getLayoutMetrics', {}, sessionId); const content = metrics.cssContentSize ?? metrics.contentSize;
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: Math.ceil(content.width), height: Math.ceil(content.height), scale: 1 } }, sessionId);
  const name = `${route.name}-${viewport.width}x${viewport.height}`; await mkdir(directory, { recursive: true });
  await writeFile(join(directory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
  await writeFile(join(directory, `${name}.json`), JSON.stringify(snapshot, null, 2), 'utf8');
  report.captures.push({ base, route: route.path, viewport, width: Math.ceil(content.width), height: Math.ceil(content.height) });
  return { data: screenshot.data, snapshot, width: Math.ceil(content.width), height: Math.ceil(content.height) };
}

function compareSnapshots(before, after, label) {
  if (before.nodes.length !== after.nodes.length) fail(`${label}: DOM element count changed (${before.nodes.length} -> ${after.nodes.length})`);
  const length = Math.min(before.nodes.length, after.nodes.length);
  const serviceHeadings = new Set(['Diagnoza logopedyczna', 'Terapia logopedyczna', 'Nauka czytania', 'Elektrostymulacja']);
  for (let index = 0; index < length; index += 1) {
    const left = before.nodes[index]; const right = after.nodes[index];
    const allowedHeadingChange = left.tag === 'h3' && right.tag === 'h2' && serviceHeadings.has(right.text);
    if (left.tag !== right.tag && !allowedHeadingChange) fail(`${label}: tag changed at node ${index} (${left.tag} -> ${right.tag})`);
    if (left.className !== right.className) fail(`${label}: classes changed at node ${index}`);
    for (const property of Object.keys(left.style)) if (left.style[property] !== right.style[property]) fail(`${label}: computed ${property} changed at node ${index}`);
    for (const property of ['x', 'y', 'width', 'height']) {
      const inlinePrivacyCode = left.tag === 'code' && left.text === 'cookiesAccepted' && right.text === 'cookiesAccepted';
      if (!inlinePrivacyCode && Math.abs(left.rect[property] - right.rect[property]) > 1) fail(`${label}: ${property} changed by more than 1px at node ${index} (${left.tag})`);
    }
  }
  if (Math.abs(before.body.width - after.body.width) > 1 || Math.abs(before.body.height - after.body.height) > 1)
    fail(`${label}: document geometry changed (${before.body.width}x${before.body.height} -> ${after.body.width}x${after.body.height})`);
  const beforeChanged = new Map(before.changed.map((rect) => [rect.label, rect])); const afterChanged = new Map(after.changed.map((rect) => [rect.label, rect]));
  if (beforeChanged.size !== afterChanged.size) fail(`${label}: changed-text block count differs`);
  for (const [name, left] of beforeChanged) {
    const right = afterChanged.get(name); if (!right) { fail(`${label}: missing changed-text block ${name}`); continue; }
    for (const property of ['x', 'y', 'width', 'height']) if (Math.abs(left[property] - right[property]) > 1) fail(`${label}: changed-text block ${name} changed ${property} by more than 1px`);
  }
}

const unionMasks = (beforeRects, afterRects) => {
  const before = new Map(beforeRects.map((rect) => [rect.label, rect]));
  return afterRects.flatMap((right) => { const left = before.get(right.label); if (!left) return [];
    const x = Math.floor(Math.min(left.x, right.x)) - 1; const y = Math.floor(Math.min(left.y, right.y)) - 1;
    const rightEdge = Math.ceil(Math.max(left.x + left.width, right.x + right.width)) + 1;
    const bottom = Math.ceil(Math.max(left.y + left.height, right.y + right.height)) + 1;
    return [{ x, y, width: rightEdge - x, height: bottom - y }]; });
};

async function comparePng(cdp, sessionId, before, after, masks, label) {
  const input = { before: `data:image/png;base64,${before}`, after: `data:image/png;base64,${after}`, masks };
  const comparison = (await cdp.send('Runtime.evaluate', { expression: `(async (input) => {
    const load = (src) => new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = src; });
    const [left, right] = await Promise.all([load(input.before), load(input.after)]);
    if (left.width !== right.width || left.height !== right.height) return { dimensionMismatch: [left.width, left.height, right.width, right.height] };
    const canvas = document.createElement('canvas'); canvas.width = left.width; canvas.height = left.height; const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(left, 0, 0); const a = context.getImageData(0, 0, canvas.width, canvas.height).data; context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(right, 0, 0); const b = context.getImageData(0, 0, canvas.width, canvas.height).data; let differentPixels = 0; let maxDelta = 0;
    let minX = canvas.width; let minY = canvas.height; let maxX = -1; let maxY = -1; const rows = new Map();
    const masked = (x, y) => input.masks.some((rect) => x >= rect.x && y >= rect.y && x < rect.x + rect.width && y < rect.y + rect.height);
    for (let pixel = 0; pixel < canvas.width * canvas.height; pixel += 1) { const x = pixel % canvas.width; const y = Math.floor(pixel / canvas.width); if (masked(x, y)) continue;
      const offset = pixel * 4; const delta = Math.max(Math.abs(a[offset] - b[offset]), Math.abs(a[offset + 1] - b[offset + 1]), Math.abs(a[offset + 2] - b[offset + 2]), Math.abs(a[offset + 3] - b[offset + 3]));
      if (delta) { differentPixels += 1; maxDelta = Math.max(maxDelta, delta); minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); rows.set(y, (rows.get(y) ?? 0) + 1); } }
    return { width: canvas.width, height: canvas.height, differentPixels, maxDelta,
      differenceBounds: differentPixels ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
      differenceRows: [...rows].sort((left, right) => right[1] - left[1]).slice(0, 12) };
  })(${JSON.stringify(input)})`, awaitPromise: true, returnByValue: true }, sessionId)).result.value;
  const rasterNoiseOnly = comparison.differentPixels <= 200 && comparison.maxDelta <= 12;
  report.comparisons.push({ label, masks, rasterNoiseOnly, ...comparison });
  if (comparison.dimensionMismatch) fail(`${label}: screenshot dimensions changed (${comparison.dimensionMismatch.join(', ')})`);
  if (comparison.differentPixels > 3 && !rasterNoiseOnly) fail(`${label}: ${comparison.differentPixels} pixels differ outside approved text blocks`);
}

async function interactionCapture(cdp, sessionId, base, kind, directory) {
  const viewport = kind === 'hover' ? { width: 1440, height: 900 } : { width: 375, height: 812 };
  await setViewport(cdp, sessionId, viewport); await navigate(cdp, sessionId, `${base}${kind === 'hover' ? '/' : '/contact/'}`);
  let masks = []; let assertion = true;
  if (kind === 'hover') {
    const rect = (await cdp.send('Runtime.evaluate', { expression: `(() => { const card = [...document.querySelectorAll('main div')].find((element) => element.classList.contains('min-h-[400px]')); card?.scrollIntoView({ block: 'center' }); const r = card?.getBoundingClientRect(); return r && { x:r.x,y:r.y,width:r.width,height:r.height }; })()`, returnByValue: true }, sessionId)).result.value;
    await cdp.send('Runtime.evaluate', { expression: `(() => { document.querySelectorAll('.reveal-up,.reveal-left,.reveal-right').forEach((element) => element.classList.add('active')); const decoded=Promise.all([...document.images].map((image) => image.decode?.().catch(() => {}))); return Promise.race([decoded,new Promise((resolve)=>setTimeout(resolve,3000))]); })()`, awaitPromise: true }, sessionId);
    await sleep(100); await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }, sessionId); await sleep(50);
    const state = (await cdp.send('Runtime.evaluate', { expression: `(() => { const card = [...document.querySelectorAll('main div')].find((element) => element.classList.contains('min-h-[400px]')); const paragraph = [...(card?.querySelectorAll('p') ?? [])].find((p) => p.classList.contains('text-white/80')); const r = paragraph?.getBoundingClientRect(); return { opacity: paragraph && getComputedStyle(paragraph).opacity, rect: r && { label:'hover description',x:r.x,y:r.y,width:r.width,height:r.height } }; })()`, returnByValue: true }, sessionId)).result.value;
    assertion = state.opacity === '1'; masks = state.rect ? [state.rect] : [];
  } else if (kind === 'menu') {
    await cdp.send('Runtime.evaluate', { expression: `document.getElementById('mobile-menu-btn')?.click()` }, sessionId); await sleep(250);
    const state = (await cdp.send('Runtime.evaluate', { expression: `({ expanded: document.getElementById('mobile-menu-btn')?.getAttribute('aria-expanded'), opacity: getComputedStyle(document.getElementById('mobile-menu-content')).opacity })`, returnByValue: true }, sessionId)).result.value;
    assertion = state.expanded === 'true' && state.opacity === '1';
  } else if (kind === 'modal') {
    await sleep(900);
    const state = (await cdp.send('Runtime.evaluate', { expression: `(() => { const overlay=document.getElementById('cookie-overlay'); const modal=document.getElementById('cookie-modal'); const paragraph=modal?.querySelector('p'); const r=paragraph?.getBoundingClientRect(); const m=modal?.getBoundingClientRect(); return { active:overlay?.classList.contains('active'), rect:r&&{label:'modal paragraph',x:r.x,y:r.y,width:r.width,height:r.height}, modal:m&&{width:m.width,height:m.height} }; })()`, returnByValue: true }, sessionId)).result.value;
    assertion = state.active; masks = state.rect ? [state.rect] : []; report.interactions[`${base}:modalGeometry`] = state.modal;
  }
  if (!assertion) fail(`${base} ${kind}: interaction state assertion failed`);
  const screenshot = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, sessionId);
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, `${kind}.png`), Buffer.from(screenshot.data, 'base64'));
  return { data: screenshot.data, masks };
}

async function runFunctionalChecks(cdp) {
  const first = await createSession(cdp, stableSource({ accepted: false, mockMap: false })); await cdp.send('Network.enable', {}, first.sessionId);
  await setViewport(cdp, first.sessionId, { width: 375, height: 812 }); await navigate(cdp, first.sessionId, `${baseUrl}/contact/`); await sleep(900);
  cdp.takeEvents('Network.requestWillBeSent', first.sessionId); await cdp.send('Runtime.evaluate', { expression: `document.querySelector('iframe[data-map-src]')?.scrollIntoView({ block:'center' })` }, first.sessionId); await sleep(250);
  const before = (await cdp.send('Runtime.evaluate', { expression: `({src:document.querySelector('iframe[data-map-src]')?.getAttribute('src'),modal:document.getElementById('cookie-overlay')?.classList.contains('active')})`, returnByValue: true }, first.sessionId)).result.value;
  const requestsBefore = cdp.takeEvents('Network.requestWillBeSent', first.sessionId).map((event) => event.params.request.url);
  await cdp.send('Runtime.evaluate', { expression: `document.getElementById('accept-cookies')?.click()` }, first.sessionId); await sleep(800);
  const after = (await cdp.send('Runtime.evaluate', { expression: `({src:document.querySelector('iframe[data-map-src]')?.getAttribute('src'),modal:document.getElementById('cookie-overlay')?.classList.contains('active')})`, returnByValue: true }, first.sessionId)).result.value;
  const requestsAfter = cdp.takeEvents('Network.requestWillBeSent', first.sessionId).map((event) => event.params.request.url);
  const firstResult = { noMapRequestBeforeAcceptance: !requestsBefore.some((url) => url.includes('maps.google.com')) && !before.src,
    modalVisibleBeforeAcceptance: before.modal === true, mapLoadsAfterAcceptance: after.src?.startsWith('https://maps.google.com/') && requestsAfter.some((url) => url.includes('maps.google.com')), modalClosesAfterAcceptance: after.modal === false };
  report.functional.firstVisitor = firstResult; for (const [name, passed] of Object.entries(firstResult)) if (!passed) fail(`contact first visitor: ${name} failed`);

  const returning = await createSession(cdp, stableSource({ accepted: true, mockMap: false })); await setViewport(cdp, returning.sessionId, { width: 375, height: 120 }); await navigate(cdp, returning.sessionId, `${baseUrl}/contact/`);
  const topState = (await cdp.send('Runtime.evaluate', { expression: `(() => {const f=document.querySelector('iframe[data-map-src]');const r=f?.getBoundingClientRect();return{src:f?.getAttribute('src'),top:r?.top,threshold:innerHeight+300}})()`, returnByValue: true }, returning.sessionId)).result.value;
  await cdp.send('Runtime.evaluate', { expression: `document.querySelector('iframe[data-map-src]')?.scrollIntoView({block:'center'})` }, returning.sessionId); await sleep(500);
  const returningSrc = (await cdp.send('Runtime.evaluate', { expression: `document.querySelector('iframe[data-map-src]')?.getAttribute('src')`, returnByValue: true }, returning.sessionId)).result.value;
  const returningResult = { deferredWhileFar: topState.top <= topState.threshold || !topState.src, loadsNearViewport: returningSrc?.startsWith('https://maps.google.com/') };
  report.functional.returningVisitor = returningResult; for (const [name, passed] of Object.entries(returningResult)) if (!passed) fail(`contact returning visitor: ${name} failed`);

  const blocked = await createSession(cdp, stableSource({ accepted: false, mockMap: false, storageThrows: true })); await setViewport(cdp, blocked.sessionId, { width: 375, height: 812 }); await navigate(cdp, blocked.sessionId, `${baseUrl}/contact/`); await sleep(900);
  await cdp.send('Runtime.evaluate', { expression: `document.querySelector('iframe[data-map-src]')?.scrollIntoView({block:'center'});document.getElementById('accept-cookies')?.click()` }, blocked.sessionId); await sleep(500);
  const storage = (await cdp.send('Runtime.evaluate', { expression: `({consent:document.documentElement.dataset.mapsConsent,src:document.querySelector('iframe[data-map-src]')?.getAttribute('src'),modal:document.getElementById('cookie-overlay')?.classList.contains('active'),revealed:document.querySelectorAll('.reveal-up.active,.reveal-left.active,.reveal-right.active').length})`, returnByValue: true }, blocked.sessionId)).result.value;
  const storageResult = { inMemoryConsent: storage.consent === 'granted', mapLoads: storage.src?.startsWith('https://maps.google.com/'), modalCloses: storage.modal === false, revealStillWorks: storage.revealed > 0 };
  report.functional.storageDenied = storageResult; for (const [name, passed] of Object.entries(storageResult)) if (!passed) fail(`contact denied storage: ${name} failed`);
  const missing = await fetch(`${baseUrl}/seo-test-route-that-does-not-exist/`, { redirect: 'manual' }); report.functional.notFoundStatus = missing.status;
  if (missing.status !== 404) fail(`missing route returned ${missing.status}, expected 404`);
}

await mkdir(outputDir, { recursive: true }); if (compareBaseUrl) await mkdir(compareOutputDir, { recursive: true });
const profileDir = await mkdtemp(join(tmpdir(), 'logorytm-visual-browser-'));
const browser = spawn(browserPath, ['--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--hide-scrollbars', '--lang=pl-PL'], { stdio: 'ignore', windowsHide: true });

try {
  const version = await waitForEndpoint(); const cdp = new Cdp(version.webSocketDebuggerUrl); await cdp.open(); const captureSession = await createSession(cdp, stableSource());
  for (const route of selectedRoutes) for (const viewport of selectedViewports) {
    const current = await capturePage(cdp, captureSession.sessionId, baseUrl, route, viewport, outputDir);
    if (compareBaseUrl) {
      const baseline = await capturePage(cdp, captureSession.sessionId, compareBaseUrl, route, viewport, compareOutputDir); const label = `${route.path} ${viewport.width}x${viewport.height}`;
      compareSnapshots(baseline.snapshot, current.snapshot, label);
      if (baseline.width === current.width && baseline.height === current.height) await comparePng(cdp, captureSession.sessionId, baseline.data, current.data, unionMasks(baseline.snapshot.changed, current.snapshot.changed), label);
      else fail(`${label}: full-page screenshot dimensions changed (${baseline.width}x${baseline.height} -> ${current.width}x${current.height})`);
    }
  }
  for (const kind of ['menu', 'hover']) {
    const current = await interactionCapture(cdp, (await createSession(cdp, stableSource())).sessionId, baseUrl, kind, outputDir);
    if (compareBaseUrl) { const baseline = await interactionCapture(cdp, (await createSession(cdp, stableSource())).sessionId, compareBaseUrl, kind, compareOutputDir);
      await comparePng(cdp, captureSession.sessionId, baseline.data, current.data, unionMasks(baseline.masks, current.masks), `${kind} state`); }
  }
  const currentModal = await interactionCapture(cdp, (await createSession(cdp, stableSource({ accepted: false }))).sessionId, baseUrl, 'modal', outputDir);
  if (compareBaseUrl) {
    const baselineModal = await interactionCapture(cdp, (await createSession(cdp, stableSource({ accepted: false }))).sessionId, compareBaseUrl, 'modal', compareOutputDir);
    const currentGeometry = report.interactions[`${baseUrl}:modalGeometry`]; const baselineGeometry = report.interactions[`${compareBaseUrl}:modalGeometry`];
    if (Math.abs(currentGeometry.width - baselineGeometry.width) > 1 || Math.abs(currentGeometry.height - baselineGeometry.height) > 1) fail('modal geometry changed by more than 1px');
    await comparePng(cdp, captureSession.sessionId, baselineModal.data, currentModal.data, unionMasks(baselineModal.masks, currentModal.masks), 'first-visit modal');
  }
  await runFunctionalChecks(cdp); await writeFile(join(outputDir, 'visual-report.json'), JSON.stringify({ ...report, failures }, null, 2), 'utf8'); void cdp.send('Browser.close').catch(() => {});
} finally {
  browser.kill();
  await sleep(500);
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
}

if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`Visual regression passed: ${selectedRoutes.length * selectedViewports.length} full-page captures, interaction states, map consent, storage failure, and 404.`);
