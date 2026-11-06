// Runs the exact pipeline the viewer uses, in Node: pdf.js (legacy build) -> core/extract -> core/pipeline.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { extractPage, readOutline } from '../../extension/js/core/extract.js';
import { analyze } from '../../extension/js/core/pipeline.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(here, '../..');
const fontDir = path.join(ROOT, 'node_modules/pdfjs-dist/standard_fonts/');

export async function extractPdf(file, { maxPages = Infinity } = {}) {
  const data = new Uint8Array(fs.readFileSync(file));
  const doc = await pdfjs.getDocument({ data, standardFontDataUrl: fontDir, disableFontFace: true, verbosity: 0, isEvalSupported: false }).promise;
  const raws = [];
  for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) { const page = await doc.getPage(p); raws.push(await extractPage(page, pdfjs.OPS)); page.cleanup(); }
  const outline = await readOutline(doc);
  await doc.destroy();
  return { raws, outline };
}

export async function analyzePdf(file, options = {}) {
  const t0 = performance.now();
  const { raws, outline } = await extractPdf(file, { maxPages: options.maxPages });
  const t1 = performance.now();
  const res = analyze(raws, outline, options);
  res.timing = { extractMs: Math.round(t1 - t0), buildMs: Math.round(performance.now() - t1) };
  return res;
}

// "U1 MCU" -> "U1"; pin reference as the UI shows it.
export const refOf = comp => (comp || '').split(/\s+/)[0];
export const pinsOf = node => node.labels.filter(l => l.comp).map(l => `${refOf(l.comp)}.${l.text.str}`);
export const findNode = (res, name) => res.nodes.find(n => n.names.has(name));
export const sample = name => path.join(ROOT, 'samples', name);
