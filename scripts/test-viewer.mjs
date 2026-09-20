// Real CPU conversion and browser rendering of SYNTHETIC splats. Not a GPU reconstruction test.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { chromium } from '@playwright/test';
import { renderViewerHtml, js } from '@playcanvas/supersplat-viewer';
import { defaultSettings, validateSettings } from '@playcanvas/supersplat-viewer/settings';

const folder = await mkdtemp(join(tmpdir(), 'astratour-viewer-'));
let browser;
let server;
try {
  const count = 1024;
  const props = ['x','y','z','f_dc_0','f_dc_1','f_dc_2','opacity','scale_0','scale_1','scale_2','rot_0','rot_1','rot_2','rot_3'];
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${count}\n${props.map(p => `property float ${p}\n`).join('')}end_header\n`;
  const data = Buffer.alloc(count * props.length * 4);
  for (let i = 0; i < count; i++) {
    const angle = i * Math.PI * (3 - Math.sqrt(5));
    const y = 1 - 2 * i / (count - 1), radius = Math.sqrt(1 - y * y);
    const values = [Math.cos(angle)*radius, y, Math.sin(angle)*radius, 0.8, -0.3, 0.6, 3, -3, -3, -3, 1, 0, 0, 0];
    values.forEach((v,j) => data.writeFloatLE(v, (i * props.length + j) * 4));
  }
  const ply = join(folder, 'synthetic.ply'), sog = join(folder, 'scene.sog'), html = join(folder, 'index.html');
  await writeFile(ply, Buffer.concat([Buffer.from(header), data]));
  const settings = defaultSettings();
  settings.cameras = [{ initial: { position: [0, 0, 4], target: [0, 0, 0], fov: 60 } }];
  validateSettings(settings, { limits: true });
  const settingsPath = join(folder, 'settings.json');
  await writeFile(settingsPath, JSON.stringify(settings));
  const transform = resolve('worker/node_modules/.bin/splat-transform');
  for (const args of [['--gpu','cpu',ply,'--filter-nan','--rotate','-90,0,0',sog],
    ['--gpu','cpu','--viewer-settings',settingsPath,sog,html]]) {
    const result = spawnSync(transform, args, { encoding: 'utf8', timeout: 120000 });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
  }
  const model = await readFile(sog);
  assert.ok(model.length > 1000);
  // Match the production iframe CSP and bootstrap rather than testing a different viewer.
  const source = await readFile('src/app/api/tours/[id]/viewer/route.ts', 'utf8');
  const csp = source.match(/'Content-Security-Policy': "([^"]+)"/)[1];
  const document = renderViewerHtml({ bootstrap: { settings, contentUrl: '/scene.sog', contentFilename: 'scene.sog' },
    baseHref: '/viewer/', inlineCss: true,
    bodyStartExtras: '<script>window.firstFrame=()=>document.body.dataset.rendered="true";</script>' });
  server = createServer((req,res) => {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/') { res.writeHead(200, { 'Content-Type':'text/html', 'Content-Security-Policy':csp }); res.end(document); }
    else if (path === '/viewer/index.js') { res.writeHead(200, {'Content-Type':'text/javascript'}); res.end(js); }
    else if (path === '/scene.sog') { res.writeHead(200, {'Content-Type':'application/octet-stream'}); res.end(model); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'] });
  const page = await browser.newPage();
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url()) && !request.url().startsWith(origin)) external.push(request.url()); });
  await page.goto(`${origin}/?webgl`, { waitUntil: 'load' });
  await page.locator('body[data-rendered="true"]').waitFor({ timeout: 60000 });
  assert.deepEqual(errors, [], 'Hosted viewer runtime errors');
  assert.deepEqual(external, [], 'Hosted viewer must not fetch third-party resources');
  // The worker's bundled HTML must render from file:// without any network access.
  const offline = await browser.newContext({ offline: true });
  const offlinePage = await offline.newPage();
  const offlineErrors = [];
  offlinePage.on('pageerror', error => offlineErrors.push(error.message));
  await offlinePage.addInitScript(() => { window.firstFrame = () => document.body.dataset.rendered = 'true'; });
  await offlinePage.goto(`${pathToFileURL(html).href}?webgl`, { waitUntil: 'load' });
  await offlinePage.locator('body[data-rendered="true"]').waitFor({ timeout: 60000 });
  assert.deepEqual(offlineErrors, [], 'Offline viewer runtime errors');
  console.log('PASS: synthetic PLY → SOG → bundled HTML, hosted CSP first frame and file:// offline first frame.');
  console.log('This does NOT validate COLMAP, CUDA training, real photos or model quality.');
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(folder, { recursive: true, force: true });
}
