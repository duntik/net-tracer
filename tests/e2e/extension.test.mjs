import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { serve } from '../helpers/server.mjs';
import { ROOT } from '../helpers/analyze-node.mjs';

const EXT = path.join(ROOT, 'extension');
let srv, ctx, extId;
before(async () => {
  srv = await serve();
  ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'nt-')), {
    channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  extId = new URL(sw.url()).host;
  await new Promise(r => setTimeout(r, 1000)); // onInstalled registers the redirect rule
});
after(async () => { await ctx?.close(); srv?.close(); });

test('a .pdf link opens in the viewer and is analysed', async () => {
  const page = await ctx.newPage(); const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto(`${srv.url}/samples/sample_kicad_like.pdf`);
  await page.waitForURL(/viewer\.html/);
  await page.waitForFunction(() => document.querySelectorAll('#netlist .net').length > 0, null, { timeout: 30000 });
  assert.match(await page.textContent('#stats'), /dangling ends: 2/);
  assert.equal(await page.isVisible('#srcbar'), true);
  assert.deepEqual(errors, []);
  await page.close();
});

test('popup toggles interception off and on', async () => {
  const pop = await ctx.newPage();
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await pop.waitForTimeout(300);
  assert.equal(await pop.isChecked('#intercept'), true);
  await pop.uncheck('#intercept'); await pop.waitForTimeout(300);
  const page = await ctx.newPage();
  await page.goto(`${srv.url}/samples/sample_schematic.pdf`).catch(() => {});
  await page.waitForTimeout(500);
  assert.ok(!page.url().includes('viewer.html'), 'not redirected while interception is off');
  await pop.check('#intercept'); await pop.waitForTimeout(300);
  await page.close(); await pop.close();
});
