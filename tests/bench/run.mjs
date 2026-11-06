// Benchmark the analysis on the real-schematic corpus.
//   npm run bench                 -> report.md / report.json, comparison with baseline.json
//   npm run bench -- --ci         -> also exits 1 on a regression
//   npm run bench:update          -> writes the current results as the new baseline
import fs from 'node:fs';
import path from 'node:path';
import { analyzePdf, pinsOf, refOf, ROOT } from '../helpers/analyze-node.mjs';
import { isPower } from '../../extension/js/core/model.js';
import { parseEagleSch, eagleTruth, pairScores } from './eagle.mjs';
import { kicadTruth } from './kicad.mjs';

const CORPUS = path.join(ROOT, 'tests/corpus'), OUT = path.join(ROOT, 'tests/bench');
const args = new Set(process.argv.slice(2));
const manifest = JSON.parse(fs.readFileSync(path.join(CORPUS, 'manifest.json'), 'utf8'));
const baselinePath = path.join(OUT, 'baseline.json');
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : {};

// Power families: two different families inside one net is a short the tool made up (GND + 3V3, 5V + 3V3...).
const family = n => { const s = n.toUpperCase().replace(/\s+/g, ''); if (/GND|VSS|EARTH|^PE$/.test(s)) return 'GND';
  const v = s.match(/(\d+)[V.,](\d*)/); return v ? `V${v[1]}.${v[2] || 0}` : s; };

const results = [];
for (const item of manifest) {
  const file = path.join(CORPUS, item.file);
  if (!fs.existsSync(file)) { results.push({ file: item.file, error: 'missing (run npm run corpus)' }); continue; }
  const r = { file: item.file, cad: item.cad, title: item.title };
  try {
    const res = await analyzePdf(file, { maxPages: item.schematic_pages || Infinity });
    const raws = res.pages.slice(1).map(p => p.raw), models = res.pages.slice(1).map(p => p.model);
    const wires = models.reduce((a, m) => a + m.wires, 0);
    const biggest = res.nodes.reduce((a, n) => Math.max(a, n.segs), 0);
    const shorts = res.nodes.filter(n => n.type === 'power' && new Set([...n.names].filter(isPower).map(family)).size > 1)
      .map(n => [...n.names].filter(isPower).join('+'));
    Object.assign(r, {
      pages: raws.length, segments: raws.reduce((a, x) => a + x.segments.length, 0), texts: raws.reduce((a, x) => a + x.texts.length, 0), wires,
      nets: res.nodes.length, namedNets: res.nodes.filter(n => n.name).length, netsWithPins: res.nodes.filter(n => n.labels.some(l => l.comp)).length,
      parts: res.parts.length, partsWithValue: res.parts.filter(p => p.value).length, dangling: res.nodes.reduce((a, n) => a + n.dangling, 0),
      biggestNetShare: wires ? +(biggest / wires).toFixed(3) : 0, powerShorts: shorts.length, powerShortNames: shorts.slice(0, 5),
      extractMs: res.timing.extractMs, buildMs: res.timing.buildMs, msPerPage: Math.round((res.timing.extractMs + res.timing.buildMs) / Math.max(1, raws.length)),
    });
    const gtRel = item.truth === false ? null : (item.sch || item.netlist); // truth:false = netlist is from another revision
    const gt = gtRel && fs.existsSync(path.join(CORPUS, gtRel)) ? path.join(CORPUS, gtRel) : null;
    let truth = null, truthRefs = null;
    if (gt && gt.endsWith('.sch') && fs.readFileSync(gt, 'utf8').trimStart().startsWith('<?xml')) { const e = parseEagleSch(fs.readFileSync(gt, 'utf8')); truth = eagleTruth(e); truthRefs = new Set(e.parts.keys()); r.truthSource = 'eagle'; }
    else if (gt && gt.endsWith('.net')) { const k = kicadTruth(fs.readFileSync(gt, 'utf8')); truth = k.truth; truthRefs = k.refs; r.truthSource = 'kicad'; }
    if (truth) {
      const pred = new Map(res.nodes.map(n => [n.key, pinsOf(n)]));
      const s = pairScores(pred, truth);
      const refs = new Set(res.parts.map(p => p.ref));
      const enough = s.matchedPins >= 10; // fewer matched pins than that says nothing about connectivity
      Object.assign(r, { truth: true, precision: enough ? +s.precision.toFixed(3) : null, recall: enough ? +s.recall.toFixed(3) : null, f1: enough ? +s.f1.toFixed(3) : null,
        pinCoverage: +s.coverage.toFixed(3), matchedPins: s.matchedPins, truthPins: s.truthPins,
        partRecall: truthRefs.size ? +([...truthRefs].filter(x => refs.has(x)).length / truthRefs.size).toFixed(3) : null });
    }
  } catch (e) { r.error = String(e && e.message || e); }
  results.push(r);
  console.log(`${r.error ? 'ERR ' : 'ok  '} ${item.file.padEnd(46)} ${r.error || `nets ${r.nets} parts ${r.parts}${r.truth ? ` F1 ${r.f1 ?? '–'} (P ${r.precision ?? '–'} R ${r.recall ?? '–'}, pins ${r.matchedPins}/${r.truthPins})` : ''}${r.powerShorts ? ` SHORTS ${r.powerShorts}` : ''} ${r.msPerPage} ms/page`}`);
}

// ---- comparison with the baseline
const regressions = [];
for (const r of results) {
  const b = baseline[r.file]; if (!b) continue;
  if (r.error && !b.error) regressions.push(`${r.file}: now fails (${r.error})`);
  if (r.truth && b.truth && b.f1 != null && (r.f1 == null || r.f1 < b.f1 - 0.02)) regressions.push(`${r.file}: F1 ${b.f1} -> ${r.f1}`);
  if (r.truth && b.truth && b.pinCoverage != null && r.pinCoverage < b.pinCoverage - 0.02) regressions.push(`${r.file}: pin coverage ${b.pinCoverage} -> ${r.pinCoverage}`);
  if (r.powerShorts > (b.powerShorts || 0)) regressions.push(`${r.file}: power shorts ${b.powerShorts || 0} -> ${r.powerShorts}`);
  if (b.netsWithPins && r.netsWithPins < b.netsWithPins * 0.9) regressions.push(`${r.file}: nets with pins ${b.netsWithPins} -> ${r.netsWithPins}`);
}

// ---- report
const truthRows = results.filter(r => r.truth && r.f1 != null), coverRows = results.filter(r => r.truth);
const mean = k => truthRows.length ? +(truthRows.reduce((a, r) => a + r[k], 0) / truthRows.length).toFixed(3) : null;
const summary = { files: results.length, failed: results.filter(r => r.error).length, withTruth: truthRows.length,
  meanPrecision: mean('precision'), meanRecall: mean('recall'), meanF1: mean('f1'), meanPinCoverage: coverRows.length ? +(coverRows.reduce((a, r) => a + r.pinCoverage, 0) / coverRows.length).toFixed(3) : null, scored: truthRows.length,
  filesWithPowerShorts: results.filter(r => r.powerShorts).length, regressions };
fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ summary, results }, null, 2));
const row = r => r.error ? `| ${r.file.replace('files/', '')} | ${r.cad || ''} | error: ${r.error} |||||||` :
  `| ${r.file.replace('files/', '')} | ${r.cad} | ${r.pages} | ${r.nets} / ${r.netsWithPins} | ${r.parts} | ${r.truth ? `${r.f1 ?? '–'} (${r.precision ?? '–'} / ${r.recall ?? '–'}), pins ${r.matchedPins}/${r.truthPins}` : '—'} | ${r.powerShorts || ''} | ${r.biggestNetShare} | ${r.msPerPage} |`;
const md = [`# Benchmark — ${new Date().toISOString().slice(0, 10)}`, '',
  `Files: ${summary.files} (failed ${summary.failed}). With a ground-truth netlist (Eagle .sch / KiCad .net): ${results.filter(r => r.truth).length}, scored (≥10 matched pins): ${summary.scored} — mean F1 ${summary.meanF1} (precision ${summary.meanPrecision}, recall ${summary.meanRecall}), pin coverage ${summary.meanPinCoverage}. Files with made-up power shorts: ${summary.filesWithPowerShorts}.`, '',
  regressions.length ? `**Regressions:**\n${regressions.map(x => `- ${x}`).join('\n')}\n` : 'No regressions against the baseline.', '',
  '| file | CAD | pages | nets / with pins | parts | F1 (P / R), pins | power shorts | biggest net share | ms/page |', '|---|---|---|---|---|---|---|---|---|', ...results.map(row)].join('\n');
fs.writeFileSync(path.join(OUT, 'report.md'), md + '\n');
console.log('\n' + md.split('\n').slice(2, 5).join('\n'));

if (args.has('--update-baseline')) {
  const keep = Object.fromEntries(results.map(r => [r.file, Object.fromEntries(Object.entries(r).filter(([k]) => ['error', 'truth', 'f1', 'precision', 'recall', 'pinCoverage', 'powerShorts', 'netsWithPins', 'nets', 'parts'].includes(k)))]));
  fs.writeFileSync(baselinePath, JSON.stringify(keep, null, 2) + '\n'); console.log('baseline updated');
}
if (args.has('--ci') && regressions.length) process.exit(1);
