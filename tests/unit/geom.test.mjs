import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mul, ap, dist, segPointDist, rgb, wkey, bboxOf, Grid } from '../../extension/js/core/geom.js';

test('affine helpers', () => {
  assert.deepEqual(ap([1, 0, 0, 1, 10, 20], 1, 2), [11, 22]);
  assert.deepEqual(ap(mul([2, 0, 0, 2, 0, 0], [1, 0, 0, 1, 5, 5]), 1, 1), [12, 12]); // translate, then scale
  assert.equal(dist(0, 0, 3, 4), 5);
});

test('segPointDist clamps to the segment', () => {
  const s = { x1: 0, y1: 0, x2: 10, y2: 0 };
  assert.deepEqual(segPointDist(s, 5, 3), { d: 3, t: 0.5 });
  assert.equal(segPointDist(s, -4, 3).d, 5);
  assert.equal(segPointDist(s, -4, 3).t, 0);
});

test('colour and width keys', () => {
  assert.equal(rgb([255, 0, 128]), '#ff0080');
  assert.equal(rgb([300, -5, 0]), '#ff0000');
  assert.equal(rgb(null), '#000000');
  assert.equal(wkey(0.54), '0.55');
  assert.equal(wkey(0.7), '0.70');
});

test('bboxOf and Grid', () => {
  assert.deepEqual(bboxOf([[3, 4], [-1, 9], [2, 0]]), { x0: -1, y0: 0, x1: 3, y1: 9 });
  const g = new Grid(10);
  g.add('a', 0, 0, 5, 5); g.add('b', 50, 50, 55, 55); g.add('c', 0, 0, 100, 0);
  assert.deepEqual([...g.query(1, 1, 2, 2)].sort(), ['a', 'c']);
  assert.deepEqual([...g.query(51, 51, 52, 52)], ['b']);
});
