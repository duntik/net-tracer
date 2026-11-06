// Downloads the corpus listed in tests/corpus/manifest.json into tests/corpus/files/ (skips files already present).
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../helpers/analyze-node.mjs';

const dir = path.join(ROOT, 'tests/corpus');
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
let ok = 0, failed = 0;
for (const item of manifest) {
  for (const [rel, url] of [[item.file, item.source_url], [item.sch, item.sch_source_url], [item.netlist, item.netlist_source_url]]) {
    if (!rel || !url) continue;
    const dest = path.join(dir, rel);
    if (fs.existsSync(dest) && fs.statSync(dest).size > 0) { ok++; continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    try {
      const res = await fetch(url); if (!res.ok) throw new Error(`HTTP ${res.status}`);
      fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer())); ok++; console.log('got', rel);
    } catch (e) { failed++; console.warn('FAILED', rel, url, e.message); }
  }
}
console.log(`corpus: ${ok} files ready, ${failed} failed`);
