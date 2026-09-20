import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';

// Run against an unconfigured local build. No OAuth bypass or production test account is created.
const origin = process.env.SMOKE_ORIGIN || 'http://localhost:3000';
const browser = await chromium.launch({
  executablePath: process.env.BROWSER_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
});
const errors = [];
const page = await browser.newPage();
page.on('pageerror', error => errors.push(error.message));
await mkdir('docs/screenshots', { recursive: true });
try {
  for (const [label, width, height] of [['desktop', 1440, 1000], ['mobile', 390, 844]]) {
    await page.setViewportSize({ width, height });
    const response = await page.goto(origin, { waitUntil: 'networkidle' });
    assert.equal(response.status(), 200);
    assert.equal(await page.locator('main section').count(), 4);
    assert.equal(await page.getByRole('button', { name: 'Generar previsualización', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Descargar Tour 3D en Alta Resolución - 19€', exact: true }).isDisabled(), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `${label}: overflow`);
    await page.screenshot({ path: `docs/screenshots/astratour-${label}.png`, fullPage: true });
    console.log(`${label}: 200 OK, 4 steps, protected controls, no horizontal overflow.`);
  }
  assert.deepEqual(errors, [], 'Browser runtime errors');
  await page.getByRole('link', { name: /Explora/ }).click();
  assert.equal(new URL(page.url()).hash, '#step-3');
  console.log('Step navigation works. No browser runtime errors.');
} finally { await browser.close(); }
