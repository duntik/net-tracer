import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { chromium, devices } from 'playwright';
import { serve } from '../helpers/server.mjs';
import { sample } from '../helpers/analyze-node.mjs';

let srv, browser;
before(async () => { srv = await serve(); browser = await chromium.launch(); });
after(async () => { await browser?.close(); srv?.close(); });

const ready = p => p.waitForFunction(() => document.querySelectorAll('#netlist .net').length > 0 && document.getElementById('busy').style.display === 'none', null, { timeout: 30000 });
async function open(ctxOpts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, acceptDownloads: true, ...ctxOpts });
  const page = await ctx.newPage(); const errors = [], warnings = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); if (m.type() === 'warning') warnings.push(m.text()); });
  await page.goto(`${srv.url}/extension/viewer.html`);
  return { ctx, page, errors, warnings };
}

test('open a multi-page PDF, select a net, step its labels, search, parts, CSV', async () => {
  const { ctx, page, errors, warnings } = await open();
  await page.setInputFiles('#file', sample('sample_multipage.pdf'));
  await ready(page);
  assert.ok(!warnings.some(w => w.includes('falling back')), 'analysis ran in the worker');
  assert.match(await page.textContent('#stats'), /pages: 2/);

  await page.click('#netlist .net:has-text("GND")');
  assert.match(await page.textContent('#detail'), /GND\s*PWR/);
  assert.deepEqual(await page.$$eval('#pageDots span', s => s.map(x => x.classList.contains('has'))), [true, true]);
  const before = await page.textContent('#lblGo');
  await page.click('#lblNext');
  assert.notEqual(await page.textContent('#lblGo'), before);

  await page.fill('#search', 'SENSOR_A');
  await page.waitForFunction(() => /results/.test(document.getElementById('searchInfo').textContent));
  assert.match(await page.textContent('#searchInfo'), /\d+ results · \d+ exact/);

  await page.click('#tabs button[data-tab="parts"]');
  await page.fill('#search', '');
  await page.click('#partlist .part:has-text("Q1")');
  assert.equal(await page.evaluate(() => window.__S.pageIndex), 2, 'jumped to the part page');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#menuBtn').then(() => page.click('#csvParts'))]);
  const csv = fs.readFileSync(await dl.path(), 'utf8');
  assert.ok(csv.startsWith('﻿reference,value,units,page'));
  assert.ok(csv.includes('Q1,'));
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('demo schematic and language switch', async () => {
  const { ctx, page, errors } = await open();
  await page.click('#demo');
  await ready(page);
  await page.selectOption('#lang', 'ru');
  assert.match(await page.textContent('#tabs'), /Цепи/);
  await page.selectOption('#lang', 'en');
  assert.match(await page.textContent('#tabs'), /Nets/);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('phone layout: bottom sheet and tap-to-select', async () => {
  const { ctx, page, errors } = await open({ ...devices['Pixel 7'] });
  await page.setInputFiles('#file', sample('sample_schematic.pdf'));
  await ready(page);
  const h = async () => { await page.waitForTimeout(350); return page.evaluate(() => document.querySelector('aside').getBoundingClientRect().height); }; // sheet animates for 0.18 s
  const normal = await h();
  await page.tap('#sheetToggle'); assert.ok(await h() > normal);
  await page.tap('#sheetToggle'); assert.ok(Math.abs(await h() - normal) < 2);
  // tap on the GND trunk (x=500, y=300 in PDF space of the 595pt-high page)
  const z = await page.evaluate(() => window.__S.zoom);
  const bb = await page.$eval('#overlay', e => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
  await page.touchscreen.tap(bb.x + 500 * z, bb.y + (595.28 - 300) * z);
  await page.waitForTimeout(300);
  const chooser = await page.evaluate(() => document.getElementById('chooser').style.display);
  const sel = await page.evaluate(() => window.__S.selKey);
  assert.ok(sel || chooser === 'block', 'a tap selects a net or offers a choice');
  assert.deepEqual(errors, []);
  await ctx.close();
});
