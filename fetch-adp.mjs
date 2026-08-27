#!/usr/bin/env node
// Pulls 2026 ADP from Fantasy Football Calculator (free, no auth) for all four
// scoring formats and writes adp-data.json. Re-run the morning of the draft.
//
// Note: FFC ignores the `teams` param -- total_drafts is identical for 10/12/14,
// the data is pooled. We request 12 purely because the endpoint wants a value.

import { writeFileSync } from 'node:fs';

const FORMATS = ['ppr', 'half-ppr', 'standard', '2qb'];
const YEAR = 2026;
const MIN_PLAYERS = 200; // per-format floor; FFC re-aggregates weekly so counts drift

const url = (f) =>
  `https://fantasyfootballcalculator.com/api/v1/adp/${f}?teams=12&year=${YEAR}&position=all`;

async function fetchFormat(f) {
  const res = await fetch(url(f), { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${f}: HTTP ${res.status}`);
  const body = await res.json();
  if (body.status !== 'Success') throw new Error(`${f}: status ${body.status}`);

  const players = body.players.map((p) => ({
    id: `${p.player_id}`,
    name: p.name,
    pos: p.position === 'PK' ? 'K' : p.position, // normalize kicker label
    team: p.team,
    adp: p.adp,
    stdev: p.stdev,
    high: p.high,
    low: p.low,
    n: p.times_drafted,
    bye: p.bye,
  }));

  players.sort((a, b) => a.adp - b.adp);
  return { meta: body.meta, players };
}

const out = { fetchedAt: new Date().toISOString(), year: YEAR, formats: {} };
const problems = [];

for (const f of FORMATS) {
  try {
    const { meta, players } = await fetchFormat(f);
    out.formats[f] = {
      label: meta.type,
      totalDrafts: meta.total_drafts,
      window: [meta.start_date, meta.end_date],
      players,
    };

    const bad = players.filter((p) => !p.stdev || !Number.isFinite(p.stdev));
    const noBye = players.filter((p) => !p.bye);
    console.log(
      `${f.padEnd(9)} ${String(players.length).padStart(3)} players  ` +
        `${String(meta.total_drafts).padStart(5)} drafts  ` +
        `${meta.start_date}..${meta.end_date}` +
        (bad.length ? `  !! ${bad.length} bad stdev` : '') +
        (noBye.length ? `  (${noBye.length} missing bye)` : '')
    );

    if (players.length < MIN_PLAYERS) problems.push(`${f}: only ${players.length} players (< ${MIN_PLAYERS})`);
    if (bad.length) problems.push(`${f}: ${bad.length} players with null/zero stdev`);
  } catch (err) {
    problems.push(`${f}: ${err.message}`);
    console.error(`${f.padEnd(9)} FAILED: ${err.message}`);
  }
}

writeFileSync('adp-data.json', JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`\nwrote adp-data.json (${kb} KB, ${Object.keys(out.formats).length}/4 formats)`);

if (problems.length) {
  console.error('\nPROBLEMS:\n' + problems.map((p) => '  - ' + p).join('\n'));
  process.exit(1);
}
console.log('all checks passed');
