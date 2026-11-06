// Single source of truth for the version is extension/manifest.json.
//   node scripts/version.mjs            -> prints the version, fails if package.json / sw.js / CHANGELOG disagree
//   node scripts/version.mjs 0.8.0      -> writes 0.8.0 everywhere and adds a CHANGELOG stub
//   node scripts/version.mjs --notes    -> prints the CHANGELOG section of the current version (release notes)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const P = { manifest: 'extension/manifest.json', pkg: 'package.json', sw: 'extension/sw.js', changelog: 'CHANGELOG.md' };
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(ROOT, f), s);
const SEMVER = /^\d+\.\d+\.\d+$/;

const manifestVersion = () => JSON.parse(read(P.manifest)).version;
const swVersion = () => (read(P.sw).match(/const VERSION = 'nt-v([^']+)'/) || [])[1];
const notesOf = v => { const m = read(P.changelog).match(new RegExp(`## \\[${v.replace(/\./g, '\\.')}\\][^\\n]*\\n([\\s\\S]*?)(?=\\n## \\[|$)`)); return m ? m[1].trim() : null; };

const arg = process.argv[2];
if (arg === '--notes') { const v = manifestVersion(); const n = notesOf(v); if (!n) { console.error(`CHANGELOG has no section for ${v}`); process.exit(1); } console.log(n); process.exit(0); }
if (arg) {
  if (!SEMVER.test(arg)) { console.error('usage: node scripts/version.mjs X.Y.Z'); process.exit(1); }
  const m = JSON.parse(read(P.manifest)); m.version = arg; write(P.manifest, JSON.stringify(m, null, 2) + '\n');
  const p = JSON.parse(read(P.pkg)); p.version = arg; write(P.pkg, JSON.stringify(p, null, 2) + '\n');
  write(P.sw, read(P.sw).replace(/const VERSION = 'nt-v[^']+'/, `const VERSION = 'nt-v${arg}'`));
  if (!notesOf(arg)) write(P.changelog, read(P.changelog).replace(/\n## \[/, `\n## [${arg}] — ${new Date().toISOString().slice(0, 10)}\n\n- …\n\n## [`));
  console.log(`version set to ${arg}; fill in CHANGELOG.md`);
  process.exit(0);
}
const v = manifestVersion(), problems = [];
if (!SEMVER.test(v)) problems.push(`manifest version "${v}" is not X.Y.Z`);
if (JSON.parse(read(P.pkg)).version !== v) problems.push(`package.json version is ${JSON.parse(read(P.pkg)).version}, manifest is ${v}`);
if (swVersion() !== v) problems.push(`sw.js cache version is ${swVersion()}, manifest is ${v}`);
if (!notesOf(v)) problems.push(`CHANGELOG.md has no "## [${v}]" section`);
if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
console.log(v);
