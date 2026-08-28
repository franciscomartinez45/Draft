#!/usr/bin/env node
// Inlines engine.mjs + adp-data.json into template.html -> index.html.
// The result makes ZERO external requests (except Google Fonts), which is both
// an Artifact CSP requirement and what makes it work offline at the draft table.
import { readFileSync, writeFileSync, statSync } from 'node:fs';

const engine = readFileSync('engine.mjs', 'utf8')
  .replace(/^export (const|function|let) /gm, '$1 ');   // inline, not a module export

if (/^\s*import\s/m.test(engine)) throw new Error('engine.mjs must have no imports');

const data = JSON.parse(readFileSync('adp-data.json', 'utf8'));

// Projected points are what the board actually ranks on -- ADP only decides who
// is still available. A board without them silently falls back to ranking by
// draft position, which looks identical and answers a different question.
let proj;
try {
  proj = JSON.parse(readFileSync('projections.json', 'utf8'));
} catch {
  throw new Error('projections.json is missing -- run `node fetch-projections.mjs` first');
}

// which projection each scoring format should use
const PTS_FIELD = { 'ppr': 'ppr', 'half-ppr': 'half', 'standard': 'std', '2qb': 'ppr' };
const MIN_COVERAGE = 0.95;
for (const [k, v] of Object.entries(data.formats)) {
  const field = PTS_FIELD[k] ?? 'ppr';
  let have = 0;
  for (const p of v.players) {
    const rec = proj.points[p.id];
    if (rec && Number.isFinite(rec[field])) { p.pts = rec[field]; have++; }
  }
  const cov = have / v.players.length;
  if (cov < MIN_COVERAGE) {
    throw new Error(`${k}: only ${(cov * 100).toFixed(1)}% of players have projected points ` +
      `(floor ${MIN_COVERAGE * 100}%). Re-run fetch-projections.mjs; publishing this would ` +
      `rank most of the board as worthless.`);
  }
}

const formats = Object.keys(data.formats);
if (formats.length !== 4) throw new Error(`expected 4 formats, got ${formats.length}`);
for (const [k, v] of Object.entries(data.formats)) {
  if (v.players.length < 200) throw new Error(`${k}: only ${v.players.length} players`);
}

let html = readFileSync('template.html', 'utf8');

// A position present in the data but missing from the board's column list would
// render no column at all, silently hiding those players.
const orderMatch = html.match(/BASE_POS_ORDER\s*=\s*\[([^\]]+)\]/);
if (!orderMatch) throw new Error('could not find BASE_POS_ORDER in template.html');
const shown = new Set(orderMatch[1].match(/'([A-Z]+)'/g).map(s => s.replace(/'/g, '')));
for (const [k, v] of Object.entries(data.formats)) {
  for (const pos of new Set(v.players.map(p => p.pos))) {
    if (!shown.has(pos)) throw new Error(`${k}: position "${pos}" has no board column`);
  }
}
if (!html.includes('/*__ENGINE__*/') || !html.includes('/*__DATA__*/')) {
  throw new Error('template.html is missing an injection placeholder');
}
html = html
  .replace('/*__ENGINE__*/', engine)
  // </script> inside the JSON string would close the tag early
  .replace('/*__DATA__*/', JSON.stringify(data).replace(/<\/script/gi, '<\\/script'));

for (const required of ['<!doctype html>', '<meta charset="utf-8">', 'name="viewport"', '</html>']) {
  if (!html.includes(required)) throw new Error(`standalone document is missing ${required}`);
}

const external = [...html.matchAll(/https?:\/\/[^"'\s)]+/g)].map(m => m[0])
  .filter(u => !u.startsWith('https://fonts.googleapis.com') && !u.startsWith('https://fonts.gstatic.com'));
if (external.length) throw new Error(`external requests are blocked by CSP: ${external.join(', ')}`);

writeFileSync('index.html', html);
const kb = (statSync('index.html').size / 1024).toFixed(0);
console.log(`index.html  ${kb} KB  ·  standalone document  ·  ${formats.length} formats  ·  ` +
  `${Object.values(data.formats).reduce((s, f) => s + f.players.length, 0)} player rows`);
console.log(`ADP         fetched ${data.fetchedAt.slice(0, 10)}`);
console.log(`Projections fetched ${proj.fetchedAt.slice(0, 10)}  ·  ${proj.source}  ·  ` +
  `${(proj.matchRate * 100).toFixed(1)}% joined${proj.estimated ? `, ${proj.estimated} estimated` : ''}`);
if (proj.providerUpdatedAt) {
  // The number that actually matters: when the PROVIDER last refreshed. Our own
  // fetchedAt says nothing about whether the numbers behind it moved.
  const days = (Date.now() - Date.parse(proj.providerUpdatedAt)) / 86_400_000;
  const flag = days > 7 ? '   <-- STALE, check the feed' : '';
  console.log(`            ${proj.provider} last updated ${proj.providerUpdatedAt.slice(0, 10)} ` +
    `(${days.toFixed(1)} days ago)${flag}`);
}
console.log('Re-run fetch-adp.mjs + fetch-projections.mjs the morning of the draft');
