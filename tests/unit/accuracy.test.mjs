// Rules added after the real-schematic benchmark (v0.8.0): rails, annotations, unnamed ground symbols,
// text pieces, Altium hidden tags and bookmarks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNets } from '../../extension/js/core/nets.js';
import { extractPage, readOutline } from '../../extension/js/core/extract.js';
import { powerFamily, conflictingPowerLabels, isPower } from '../../extension/js/core/names.js';

let id = 0;
const W = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, color: '#00aa00', lw: 0.7, closed: false, curve: false, id: id++ });
const G = (x1, y1, x2, y2) => ({ x1, y1, x2, y2, color: '#aa0000', lw: 1.0, closed: false, curve: false, id: id++ });
const T = (str, x0, y0, x1, y1) => ({ str, x0, y0, x1, y1 });
const page = (segments, { dots = [], texts = [], rects = [] } = {}) => {
  segments.forEach((s, i) => (s.id = i));
  return { segments, dots, rects, texts, base: { width: 500, height: 500, transform: [1, 0, 0, -1, 0, 500] } };
};
const OPT = { colors: new Set(['#00aa00', '#aa0000']), widths: new Set(['0.70']), tol: 1, labelDist: 8, needDot: false, mergeLabels: true, insideRect: true };
const netOf = (model, seg) => model.nets.find(n => n.segs.includes(seg));
const names = net => [...new Set(net.labels.filter(l => l.isNetLabel).map(l => l.text.str))].sort();

test('voltage families: generic names have none', () => {
  assert.equal(powerFamily('+3V3'), 'V3.3');
  assert.equal(powerFamily('VDD_3P3V'), 'V3.3');
  assert.equal(powerFamily('3.3V'), 'V3.3');
  assert.equal(powerFamily('SYS_5V'), 'V5.0');
  assert.equal(powerFamily('AGND'), 'GND');
  assert.equal(powerFamily('VCC'), null);
  assert.ok(isPower('SYS_5V') && isPower('VDD_1V8'));
  const l = (str, d) => ({ text: { str }, isNetLabel: true, d });
  const a = l('+3V3', 0.2), b = l('GND', 3), c = l('VCC', 1);
  assert.deepEqual(conflictingPowerLabels([a, b, c]), [b]);            // the closer rail wins, VCC is an alias
  assert.deepEqual(conflictingPowerLabels([a, b], 'GND'), [a]);        // the name the net is merged by wins
});

test('one wire never carries two rails: the less reliable label is dropped', () => {
  const w = W(0, 100, 100, 100);
  const m = buildNets(page([w], { texts: [T('+3V3', 40, 96, 52, 99.6), T('GND', 70, 101.5, 80, 105)] }), OPT);
  assert.deepEqual(names(netOf(m, w)), ['+3V3']);
});

test('the same note next to neighbouring pins is not a net name', () => {
  const a = W(0, 10, 20, 10), b = W(0, 14, 20, 14), c = W(0, 18, 20, 18);
  const texts = [T('pwm', 21, 8.5, 30, 11.5), T('pwm', 21, 12.5, 30, 15.5), T('pwm', 21, 16.5, 30, 19.5)];
  const m = buildNets(page([a, b, c], { texts }), OPT);
  assert.notEqual(netOf(m, a), netOf(m, b));
  assert.notEqual(netOf(m, b), netOf(m, c));
  // a real label repeated far apart still merges
  const d = W(200, 10, 220, 10), e = W(200, 200, 220, 200);
  const m2 = buildNets(page([d, e], { texts: [T('CLK', 205, 6, 215, 9.5), T('CLK', 205, 196, 215, 199.5)] }), OPT);
  assert.equal(netOf(m2, d), netOf(m2, e));
});

test('unnamed ground symbols join as GND; a capacitor plate does not', () => {
  const w1 = W(0, 50, 40, 50), w2 = W(100, 50, 140, 50), w3 = W(200, 50, 240, 50);
  const gnd1 = [G(40, 50, 40, 55), G(36, 55, 44, 55)], gnd2 = [G(140, 50, 140, 55), G(136, 55, 144, 55)];
  const cap = [G(240, 50, 240, 55), G(236, 55, 244, 55), G(236, 57, 244, 57)];
  const m = buildNets(page([w1, w2, w3, ...gnd1, ...gnd2, ...cap]), OPT);
  assert.equal(netOf(m, w1), netOf(m, w2));
  assert.equal(netOf(m, w1).mergeName, 'GND');
  assert.notEqual(netOf(m, w3), netOf(m, w1));
  assert.equal(buildNets(page([w1, w2, ...gnd1, ...gnd2]), { ...OPT, groundSymbols: false }).nets.length, 2);
});

// a pdf.js page stand-in: no drawing, only a text layer
const fakePage = items => ({
  getOperatorList: async () => ({ fnArray: [], argsArray: [] }),
  getViewport: () => ({ width: 500, height: 500, transform: [1, 0, 0, -1, 0, 500] }),
  getTextContent: async () => ({ items }),
});
const item = (str, x, y, w, rot = 0) => ({ str, width: w, height: 3, transform: rot ? [0, 3, -3, 0, x, y] : [3, 0, 0, 3, x, y] });

test('text pieces join along their reading direction only', async () => {
  const raw = await extractPage(fakePage([
    item('VC', 100, 100, 6), item('C', 106.5, 100, 3),             // one word split in two
    item('A1', 200, 100, 6, 90), item('A2', 203.2, 100, 6, 90),    // two rotated pin names side by side
  ]), {});
  assert.deepEqual(raw.texts.map(t => t.str).sort(), ['A1', 'A2', 'VCC']);
});

test('Altium hidden cross-probe tags are dropped', async () => {
  const tags = Array.from({ length: 12 }, (_, i) => item(`PIU10${i + 10}`, 10, 20 + i * 10, 12));
  const raw = await extractPage(fakePage([...tags, item('COU1', 50, 50, 10), item('NLVREFH0', 50, 80, 20), item('VREFH0', 80, 80, 18)]), {});
  assert.deepEqual(raw.texts.map(t => t.str), ['VREFH0']);
});

test('Altium bookmarks: nets are a netlist, components are not', async () => {
  const b = (title, items = []) => ({ title, items });
  const doc = { getOutline: async () => [b('Sheet', [b('Components', [b('C1', [b('C1-1'), b('C1-2')])]), b('Nets', [b('GND', [b('C1-2'), b('U1-5')]), b('U1', [b('U1-1'), b('U1-2')])])])] };
  assert.deepEqual(await readOutline(doc), [['GND', ['C1-2', 'U1-5']]]);
});
