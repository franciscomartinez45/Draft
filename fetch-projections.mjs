#!/usr/bin/env node
// Pulls 2026 season projected fantasy points and joins them onto the FFC player
// ids already in adp-data.json -> projections.json.
//
// The projections are ROTOWIRE's; Sleeper is only the pipe (every record carries
// company: "rotowire"). The endpoint is undocumented -- Sleeper's published API
// covers players, leagues and drafts, not projections -- so it is free and
// unauthenticated but carries no stability promise. The provider name is read
// from the data rather than hardcoded, so a switch shows up instead of being
// silently mis-attributed.
//
// ADP answers "when will he be gone?". It cannot answer "how many points will he
// score?" -- that is what this is for. Run it alongside fetch-adp.mjs.
//
// The join is by normalized name for players and by team abbreviation for
// defenses (Sleeper keys those by team: player_id "SEA"). Anything unmatched
// gets a points estimate from the nearest-ADP matched player at the same
// position, so the whole board stays on ONE scale -- a board where some players
// carry projected points and others carry an ADP proxy silently compares
// different units and looks perfectly fine doing it.

import { readFileSync, writeFileSync } from 'node:fs';
import { normalizeName } from './engine.mjs';

const YEAR = 2026;
const POSITIONS = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'];
const MIN_MATCH_RATE = 0.95;   // below this the join is broken, not merely lossy

// Upstream staleness is otherwise INVISIBLE: this file records when *we*
// fetched, so a provider that quietly stopped updating still looks like a fresh
// pull. WARN is loud but publishes -- week-old projections on draft morning beat
// no board at all. FAIL is for numbers so old the feed is plainly dead.
const STALE_WARN_DAYS = 7;
const STALE_FAIL_DAYS = 45;

const url = (pos) =>
  `https://api.sleeper.com/projections/nfl/${YEAR}` +
  `?season_type=regular&position[]=${pos}&order_by=pts_ppr`;

async function fetchPos(pos) {
  const res = await fetch(url(pos), {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${pos}: HTTP ${res.status}`);
  const body = await res.json();
  if (!Array.isArray(body)) throw new Error(`${pos}: expected an array`);
  return body;
}

// ---------------------------------------------------------------- gather
const byName = new Map();     // normalized name -> {ppr, half, std}
const byTeamDef = new Map();  // team abbr       -> {ppr, half, std}
const companies = new Set();
let providerUpdatedAt = 0;

for (const pos of POSITIONS) {
  const rows = await fetchPos(pos);
  let kept = 0;
  for (const r of rows) {
    const st = r.stats || {};
    if (r.company) companies.add(String(r.company));
    const stamp = Number(r.updated_at || r.last_modified || 0);
    if (Number.isFinite(stamp) && stamp > providerUpdatedAt) providerUpdatedAt = stamp;
    if (st.pts_ppr == null) continue;
    const pts = {
      ppr: st.pts_ppr,
      half: st.pts_half_ppr ?? st.pts_ppr,
      std: st.pts_std ?? st.pts_ppr,
    };
    kept++;
    if (pos === 'DEF') {
      byTeamDef.set(String(r.player_id).toUpperCase(), pts);
      continue;
    }
    const p = r.player || {};
    const key = normalizeName(`${p.first_name || ''} ${p.last_name || ''}`.trim());
    if (!key) continue;
    // a name can appear twice (practice-squad duplicates); keep the real one
    const prev = byName.get(key);
    if (!prev || pts.ppr > prev.ppr) byName.set(key, pts);
  }
  console.log(`${pos.padEnd(4)} ${String(rows.length).padStart(5)} rows  ${String(kept).padStart(4)} with points`);
}

// ---------------------------------------------------------------- join
const adp = JSON.parse(readFileSync('adp-data.json', 'utf8'));

// every player id across all four formats, deduped
const players = new Map();
for (const f of Object.values(adp.formats)) {
  for (const p of f.players) if (!players.has(p.id)) players.set(p.id, p);
}

const points = {};
const unmatched = [];
for (const p of players.values()) {
  const hit = p.pos === 'DEF'
    ? byTeamDef.get(String(p.team).toUpperCase())
    : byName.get(normalizeName(p.name));
  if (hit) points[p.id] = hit;
  else unmatched.push(p);
}

const matchRate = (players.size - unmatched.length) / players.size;
console.log(`\njoined ${players.size - unmatched.length}/${players.size} players (${(matchRate * 100).toFixed(1)}%)`);

// Estimate the stragglers from the nearest-ADP matched player at the same
// position. Leaving them out entirely would rank them as worthless; leaving
// them on an ADP-derived scale would mix units inside a single list.
const estimated = [];
for (const p of unmatched) {
  const peers = [...players.values()]
    .filter((q) => q.pos === p.pos && points[q.id])
    .sort((a, b) => Math.abs(a.adp - p.adp) - Math.abs(b.adp - p.adp));
  if (!peers.length) continue;
  points[p.id] = { ...points[peers[0].id], est: true };
  estimated.push(`${p.name} (${p.pos}, adp ${p.adp}) <- ${peers[0].name}`);
}

const provider = [...companies].sort().join(', ') || 'unknown';
const providerUpdatedIso = providerUpdatedAt ? new Date(providerUpdatedAt).toISOString() : null;
const staleDays = providerUpdatedAt ? (Date.now() - providerUpdatedAt) / 86_400_000 : null;

const out = {
  fetchedAt: new Date().toISOString(),
  year: YEAR,
  source: `${provider} (via Sleeper)`,
  provider,
  providerUpdatedAt: providerUpdatedIso,   // when THEY last refreshed, not when we pulled
  staleDays: staleDays == null ? null : Number(staleDays.toFixed(1)),
  matchRate: Number(matchRate.toFixed(4)),
  estimated: estimated.length,
  points,
};
writeFileSync('projections.json', JSON.stringify(out));
const kb = (JSON.stringify(out).length / 1024).toFixed(0);
console.log(`wrote projections.json (${kb} KB, ${Object.keys(points).length} players, ${estimated.length} estimated)`);
if (estimated.length) console.log('  estimated: ' + estimated.slice(0, 8).join('; '));
console.log(`provider: ${provider}` +
  (providerUpdatedIso ? `  ·  they last updated ${providerUpdatedIso.slice(0, 10)} (${staleDays.toFixed(1)} days ago)` : ''));
if (companies.size > 1) {
  console.warn(`  NOTE: more than one provider in this feed (${provider}) — projections may not be consistent`);
}

if (!Object.keys(points).length) {
  console.error('\nPROBLEM: no projections at all -- refusing to write a useless board');
  process.exit(1);
}
if (staleDays != null && staleDays > STALE_FAIL_DAYS) {
  console.error(`\nPROBLEM: ${provider} last updated these projections ${staleDays.toFixed(0)} days ago ` +
    `(limit ${STALE_FAIL_DAYS}). That feed is not being maintained — publishing it would put ` +
    `stale numbers behind a fresh-looking timestamp.`);
  process.exit(1);
}
if (staleDays != null && staleDays > STALE_WARN_DAYS) {
  console.warn(`\nWARNING: ${provider} last updated ${staleDays.toFixed(1)} days ago. ` +
    `Publishing anyway — old projections still beat none — but check whether the feed is alive.`);
}
if (matchRate < MIN_MATCH_RATE) {
  console.error(`\nPROBLEM: only ${(matchRate * 100).toFixed(1)}% of the board matched ` +
    `(floor is ${MIN_MATCH_RATE * 100}%). Sleeper may have changed its shape, or a lot of ` +
    `names drifted. Estimating this many players would be guessing, not projecting.`);
  process.exit(1);
}
console.log('all checks passed');
