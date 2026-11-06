// The synthetic sample PDFs in samples/ go through the real pdf.js + pipeline, and the expected
// connectivity was checked by hand against the drawing generator (samples/make_*.py).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePdf, findNode, pinsOf, sample } from '../helpers/analyze-node.mjs';
import { search } from '../../extension/js/core/search.js';

const sorted = a => [...a].sort();

test('EasyEDA-style colour sheet', async () => {
  const r = await analyzePdf(sample('sample_schematic.pdf'));
  assert.equal(r.pages.length - 1, 1);
  const gnd = findNode(r, 'GND');
  assert.equal(gnd.type, 'power');
  assert.deepEqual(sorted(pinsOf(gnd)), sorted(['U1.GND', 'U1.GND', 'U2.OUT-', 'H1.GND', 'U3.VIN-', 'S1.GND', 'C1.-']));
  assert.deepEqual(sorted(pinsOf(findNode(r, 'VIN'))), sorted(['U1.VIN', 'U2.OUT+', 'U3.VIN+', 'C1.+']));
  assert.deepEqual(sorted(pinsOf(findNode(r, 'SENSOR_A'))), ['U1.D35']);
  const cs = r.nodes.find(n => pinsOf(n).includes('H1.CS'));
  assert.deepEqual(sorted(pinsOf(cs)), ['H1.CS', 'U1.D5']);
  assert.equal(r.nodes.reduce((a, n) => a + n.dangling, 0), 0);
  assert.deepEqual(r.parts.map(p => p.ref), ['C1', 'H1', 'R1', 'S1', 'U1', 'U2', 'U3']);
});

test('black-and-white KiCad-style sheet: symbols without bodies, power symbols, a dangling wire', async () => {
  const r = await analyzePdf(sample('sample_kicad_like.pdf'));
  const gnd = findNode(r, 'GND'), vcc = findNode(r, 'VCC');
  assert.notEqual(gnd, vcc);
  for (const p of ['U1.GND', 'U2.GND', 'J1.GND', 'Q1.E', 'C1.2']) assert.ok(pinsOf(gnd).includes(p), p);
  for (const p of ['U1.VCC', 'U2.VDD', 'J1.V+', 'R1.1', 'R2.1', 'C1.1']) assert.ok(pinsOf(vcc).includes(p), p);
  const byPin = pin => r.nodes.find(n => pinsOf(n).includes(pin));
  assert.deepEqual(sorted(pinsOf(byPin('U1.SCL'))), sorted(['R1.2', 'U2.3', 'U2.SCL', 'U1.11', 'U1.SCL']));
  assert.deepEqual(sorted(pinsOf(byPin('U1.SDA'))), sorted(['R2.2', 'U2.4', 'U2.SDA', 'U1.12', 'U1.SDA']));
  assert.equal(byPin('U1.SCL').name, '', 'pin names inside bodies must not name a net');
  assert.ok(pinsOf(byPin('U1.PB0')).includes('Q1.B'));
  assert.equal(r.nodes.reduce((a, n) => a + n.dangling, 0), 2);
  for (const ref of ['Q1', 'R1', 'R2', 'C1', 'J1', 'U1', 'U2']) assert.ok(r.parts.some(p => p.ref === ref), ref);
});

test('multi-page: same-name labels merge across sheets; search ranks exact hits first', async () => {
  const r = await analyzePdf(sample('sample_multipage.pdf'));
  assert.equal(r.pages.length - 1, 2);
  const gnd = findNode(r, 'GND');
  assert.deepEqual([...gnd.pages].sort(), [1, 2]);
  const hits = search('gnd', r.pages, r.nodes, r.parts);
  assert.ok(hits.length >= 10);
  assert.ok(hits[0].exact && hits[0].kind === 'net');
  assert.deepEqual(search('', r.pages, r.nodes, r.parts), []);
});
