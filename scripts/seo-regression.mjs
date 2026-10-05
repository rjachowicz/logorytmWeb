import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const baseUrl = process.env.SEO_TEST_URL ?? 'http://127.0.0.1:4321';
const outputDir = process.argv[2];
const compareBaseUrl = process.env.SEO_COMPARE_URL;
const compareOutputDir = process.env.SEO_COMPARE_OUTPUT;
const edgePath = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const port = Number(process.env.SEO_CDP_PORT ?? 9222);
const routes = ['/', '/about', '/services', '/pricing', '/contact', '/privacy'];
const selectedRoutes = process.env.SEO_TEST_ROUTES
  ? process.env.SEO_TEST_ROUTES.split(',')
  : routes;
const viewports = [
  { width: 375, height: 812 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
];
const selectedViewports = process.env.SEO_TEST_VIEWPORTS
  ? viewports.filter(({ width, height }) => process.env.SEO_TEST_VIEWPORTS.split(',').includes(`${width}x${height}`))
  : viewports;
const settleMs = Number(process.env.SEO_SETTLE_MS ?? 1500);

if (!outputDir) {
  throw new Error('Pass an output directory as the first argument.');
}
if (Boolean(compareBaseUrl) !== Boolean(compareOutputDir)) {
  throw new Error('SEO_COMPARE_URL and SEO_COMPARE_OUTPUT must be provided together.');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
      } else {
        this.events.push(message);
      }
    });
  }

  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const request = { id, method, params };
    if (sessionId) request.sessionId = sessionId;
    this.ws.send(JSON.stringify(request));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }

  async waitFor(method, sessionId) {
    for (;;) {
      const index = this.events.findIndex((event) => event.method === method && (!sessionId || event.sessionId === sessionId));
      if (index >= 0) return this.events.splice(index, 1)[0];
      await sleep(20);
    }
  }
}

async function waitForEndpoint() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return response.json();
    } catch {}
    await sleep(50);
  }
  throw new Error('Edge remote-debugging endpoint did not start.');
}

await mkdir(outputDir, { recursive: true });
if (compareOutputDir) await mkdir(compareOutputDir, { recursive: true });
const profileDir = join(outputDir, `edge-profile-${port}`);
const edge = spawn(edgePath, [
  '--headless=new',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  '--no-first-run',
  '--no-default-browser-check',
], { stdio: 'ignore', windowsHide: true });

try {
  const version = await waitForEndpoint();
  const cdp = new Cdp(version.webSocketDebuggerUrl);
  await cdp.open();
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  await cdp.send('Runtime.enable', {}, sessionId);
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `
      localStorage.setItem('cookiesAccepted', 'true');
      document.addEventListener('DOMContentLoaded', () => {
        const style = document.createElement('style');
        style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}';
        document.head.append(style);
      }, { once: true });
    `,
  }, sessionId);

  for (const route of selectedRoutes) {
    for (const { width, height } of selectedViewports) {
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height,
      }, sessionId);
      const captures = [
        { url: baseUrl, directory: outputDir },
        ...(compareBaseUrl ? [{ url: compareBaseUrl, directory: compareOutputDir }] : []),
      ];
      for (const capture of captures) {
        await cdp.send('Page.navigate', { url: `${capture.url}${route}` }, sessionId);
        await cdp.waitFor('Page.loadEventFired', sessionId);
        await cdp.send('Runtime.evaluate', {
          expression: 'document.fonts.ready',
          awaitPromise: true,
        }, sessionId);
        await sleep(settleMs);
        const viewport = await cdp.send('Runtime.evaluate', {
          expression: 'JSON.stringify({width: window.innerWidth, height: window.innerHeight})',
          returnByValue: true,
        }, sessionId);
        const dimensions = JSON.parse(viewport.result.value);
        if (dimensions.width !== width || dimensions.height !== height) {
          throw new Error(`Viewport mismatch for ${route}: ${dimensions.width}x${dimensions.height}, expected ${width}x${height}`);
        }
        const body = await cdp.send('Runtime.evaluate', {
          expression: 'document.body.outerHTML', returnByValue: true,
        }, sessionId);
        const screenshot = await cdp.send('Page.captureScreenshot', {
          format: 'png', fromSurface: true, captureBeyondViewport: false,
        }, sessionId);
        const name = `${route === '/' ? 'home' : route.slice(1)}-${width}x${height}`;
        await writeFile(join(capture.directory, `${name}.html`), body.result.value, 'utf8');
        await writeFile(join(capture.directory, `${name}.png`), Buffer.from(screenshot.data, 'base64'));
      }
    }
  }
  void cdp.send('Browser.close').catch(() => {});
  console.log(`Saved ${selectedRoutes.length * selectedViewports.length} screenshots in ${outputDir}`);
} finally {
  edge.kill();
}
