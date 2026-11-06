import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPower, REFDES_RE } from '../../extension/js/core/model.js';
import { csvCell, partsCsv } from '../../extension/js/core/export.js';

test('power net names', () => {
  for (const n of ['GND', 'AGND', 'VCC', 'VDD', '+3V3', '+3.3V', '5V', '-12V', 'VBAT', 'VIN', 'PP3V3_S0', '3V3', 'V+'])
    assert.ok(isPower(n), n);
  for (const n of ['SDA', 'SCL', 'RESET', 'TX', 'D5', 'PA0', 'LED_K', 'SENSOR_A'])
    assert.ok(!isPower(n), n);
});

test('reference designators', () => {
  for (const r of ['R1', 'C37', 'U4A', 'Q12', 'J3', 'IC1']) assert.ok(REFDES_RE.test(r), r);
  for (const r of ['GND', '10k', 'R', '12', 'VCC1V8X']) assert.ok(!REFDES_RE.test(r), r);
});

test('CSV cells are Excel-safe', () => {
  assert.equal(csvCell('+5V'), '="+5V"');
  assert.equal(csvCell('-12V'), '="-12V"');
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell(null), '');
  assert.equal(partsCsv([{ ref: 'R5', value: '10k', units: new Set(['B', 'A']), page: 2 }]), 'reference,value,units,page\r\nR5,10k,AB,2');
});
