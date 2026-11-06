import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNets } from '../../extension/js/core/nets.js';

// Hand-made page geometry: wires are #00aa00 / 0.7, symbol graphics #aa0000 / 1.0.
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

test('end-to-end and T-junction joins; crossing without a dot does not', () => {
  const a = W(0, 100, 100, 100), b = W(100, 100, 100, 200); // corner
  const c = W(50, 100, 50, 50);                              // T onto the middle of a
  const d = W(200, 0, 200, 300), e = W(150, 150, 250, 150);  // plain crossing
  const m = buildNets(page([a, b, c, d, e]), OPT);
  assert.equal(netOf(m, a), netOf(m, b));
  assert.equal(netOf(m, a), netOf(m, c));
  assert.notEqual(netOf(m, d), netOf(m, e));
});

test('a junction dot joins a crossing; needDot requires dots for T-junctions', () => {
  const d = W(200, 0, 200, 300), e = W(150, 150, 250, 150);
  const m = buildNets(page([d, e], { dots: [{ x: 200, y: 150, r: 1.6, color: '#00aa00' }] }), OPT);
  assert.equal(netOf(m, d), netOf(m, e));
  const a = W(0, 100, 100, 100), c = W(50, 100, 50, 50);
  const strict = buildNets(page([a, c]), { ...OPT, needDot: true });
  assert.notEqual(netOf(strict, a), netOf(strict, c));
});

test('symbol graphics attach to nets but never bridge them', () => {
  const left = W(0, 50, 40, 50), right = W(60, 50, 100, 50);
  const resistor = [G(40, 50, 45, 45), G(45, 45, 55, 55), G(55, 55, 60, 50)]; // zigzag between the two wires
  const m = buildNets(page([left, right, ...resistor]), OPT);
  assert.equal(m.nets.length, 2);
  assert.notEqual(netOf(m, left), netOf(m, right));
  assert.ok(netOf(m, left).pins.length > 0, 'the resistor lead is listed as a pin line of the left net');
});

test('labels attach to the nearest wire end, value texts never do', () => {
  const a = W(0, 100, 100, 100), b = W(0, 200, 100, 200);
  const m = buildNets(page([a, b], { texts: [T('SDA', 102, 96, 118, 102), T('10k', 102, 196, 116, 202)] }), OPT);
  assert.deepEqual(netOf(m, a).labels.map(l => l.text.str), ['SDA']);
  assert.deepEqual(netOf(m, b).labels.map(l => l.text.str), []);
});

test('same-name net labels merge separate wires on a page', () => {
  const a = W(0, 100, 100, 100), b = W(300, 100, 400, 100);
  const m = buildNets(page([a, b], { texts: [T('VCC', 102, 96, 118, 102), T('VCC', 402, 96, 418, 102)] }), OPT);
  assert.equal(netOf(m, a), netOf(m, b));
  const off = buildNets(page([W(0, 100, 100, 100), W(300, 100, 400, 100)], { texts: [T('VCC', 102, 96, 118, 102), T('VCC', 402, 96, 418, 102)] }), { ...OPT, mergeLabels: false });
  assert.equal(off.nets.length, 2);
});

test('dangling ends are reported, connected ends are not', () => {
  const a = W(0, 0, 100, 0), b = W(100, 0, 100, 100);
  const m = buildNets(page([a, b]), OPT);
  assert.equal(m.nets.length, 1);
  assert.equal(m.nets[0].dangling.length, 2); // the two free ends
});

test('unticked widths are graphics', () => {
  const a = W(0, 0, 100, 0), b = W(100, 0, 200, 0);
  b.lw = 1.0;
  const m = buildNets(page([a, b]), OPT);
  assert.equal(m.wires, 1);
  assert.equal(m.graphics, 1);
});
