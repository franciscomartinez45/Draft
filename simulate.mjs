#!/usr/bin/env node
/**
 * Mock-draft harness.
 *
 * SCOPE: this proves the engine does not crash, emit NaN, or do something
 * obviously stupid across many board states. It does NOT prove the availability
 * model is correct -- ADP-following bots are drawn from the same distribution
 * the prior assumes, so they would ratify any blend weighting. Model
 * correctness is asserted in engine.test.mjs against hand-built fixtures.
 *
 * Usage: node simulate.mjs [drafts]
 */
import { readFileSync } from 'node:fs';
import * as E from './engine.mjs';

const N = Number(process.argv[2] || 300);
const DATA = JSON.parse(readFileSync('./adp-data.json', 'utf8'));

// deterministic RNG so a failure is reproducible
let seed = 12345;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

// ------------------------------------------------------------- bot profiles

const BOTS = {
  /** drafts near ADP with noise -- the friendly case */
  adp: (avail) => avail[Math.floor(Math.abs(rnd() + rnd() - 1) * 6)] ?? avail[0],

  /** piles into whatever position just went -- breaks the ADP assumption */
  run: (avail, ctx) => {
    const last = ctx.order.slice(-3).map((p) => p.pos);
    const hot = last.length ? pick(last) : null;
    const same = avail.filter((p) => p.pos === hot && !['K', 'DEF'].includes(p.pos));
    return (rnd() < 0.75 && same.length ? same[0] : avail[Math.floor(rnd() * 5)]) ?? avail[0];
  },

  /** drafts off a deliberately permuted board -- worst case for ADP priors */
  chaos: (avail) => avail[Math.floor(rnd() * Math.min(40, avail.length))] ?? avail[0],

  /** fills starting slots first, a common human pattern */
  need: (avail, ctx) => {
    const want = ['RB', 'WR', 'TE', 'QB'].find(
      (pos) => (ctx.roster[pos] || 0) < (E.DEFAULT_LINEUP[pos] || 0)
    );
    return avail.find((p) => p.pos === want) ?? avail[0];
  },
};

// ------------------------------------------------------------------ harness

const violations = [];
const flag = (msg, ctx) => violations.push(`${msg}  [${ctx}]`);

function runDraft(di) {
  const fmt = pick(Object.keys(DATA.formats));
  const players = E.computeTiers(DATA.formats[fmt].players.map((p) => ({ ...p })));
  const leagueSize = pick([8, 10, 12, 14]);
  const rounds = pick([14, 15, 16]);
  const slot = 1 + Math.floor(rnd() * leagueSize);
  const lineup = rnd() < 0.2
    ? { ...E.DEFAULT_LINEUP, SUPERFLEX: 1 }
    : E.DEFAULT_LINEUP;
  const botMix = pick([['adp'], ['adp', 'run'], ['run', 'chaos'], ['adp', 'need', 'run'], ['chaos']]);
  const tag = `#${di} ${fmt} ${leagueSize}tm slot${slot} ${botMix.join('+')}`;

  const drafted = new Set();
  const order = [];
  const roster = {};
  const myPicks = new Set(E.snakePicks(leagueSize, slot, rounds));
  const totalPicks = leagueSize * rounds;
  let myCount = 0;

  for (let n = 1; n <= totalPicks; n++) {
    const avail = players.filter((p) => !drafted.has(p.id)).sort((a, b) => a.adp - b.adp);
    if (!avail.length) break;

    let chosen;
    if (myPicks.has(n)) {
      const state = { players, drafted, draftedOrder: order, roster, lineup, leagueSize, slot, rounds };
      const rec = E.recommend(state, 3);
      const round = Math.ceil(n / leagueSize);
      const roundsLeft = rounds - round + 1;

      if (!rec.top.length) { flag(`no recommendation at pick ${n}`, tag); break; }
      for (const t of rec.top) {
        if (!Number.isFinite(t.score)) flag(`NaN score: ${t.player.name} p${n}`, tag);
        if (!Number.isFinite(t.pAvail)) flag(`NaN pAvail: ${t.player.name} p${n}`, tag);
        if (!t.reasons.length) flag(`no reason given for ${t.player.name} p${n}`, tag);
      }
      chosen = rec.top[0].player;

      // Engine guarantee: K/DEF never before the final 5 rounds, and only then
      // under genuine supply scarcity. Anything earlier is the novice mistake.
      if (['K', 'DEF'].includes(chosen.pos) && roundsLeft > 5) {
        flag(`drafted ${chosen.pos} in round ${round} of ${rounds} (${roundsLeft} left)`, tag);
      }
      if (round === 1 && chosen.adp > leagueSize * 2.5) {
        flag(`round-1 reach: ${chosen.name} adp ${chosen.adp}`, tag);
      }
      if ((roster[chosen.pos] || 0) >= 4 && !['RB', 'WR'].includes(chosen.pos)) {
        flag(`hoarding ${chosen.pos} (${roster[chosen.pos]} already)`, tag);
      }
      roster[chosen.pos] = (roster[chosen.pos] || 0) + 1;
      myCount++;
    } else {
      const ctx = { order, roster: {} };
      chosen = BOTS[pick(botMix)](avail, ctx) ?? avail[0];
    }
    drafted.add(chosen.id);
    order.push(chosen);
  }

  const boardTooSmall = players.length < totalPicks;
  if (myCount !== rounds && !boardTooSmall) {
    flag(`made ${myCount} picks, expected ${rounds}`, tag);
  }

  // did I end up able to field a legal starting lineup?
  const need = { ...lineup };
  delete need.FLEX; delete need.SUPERFLEX;
  const missing = Object.entries(need).filter(([pos, k]) => (roster[pos] || 0) < k);
  const left = players.filter((p) => !drafted.has(p.id));
  const thin = `${left.length} left, K left: ${left.filter((p) => p.pos === 'K').length}`;
  return { missing: missing.map(([p]) => p), tag, roster, boardTooSmall, thin };
}

let incomplete = 0;   // could not field a legal lineup, engine's fault
let exhausted = 0;    // board had fewer players than the draft needed
const t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  const r = runDraft(i);
  if (r.boardTooSmall) exhausted++;
  if (r.missing.length && !r.boardTooSmall) {
    // A board with fewer players than picks cannot fill every lineup -- that is
    // an ADP-coverage limit, not an engine fault. Surfaced, never silently capped.
    incomplete++;
    if (incomplete <= 8) flag(`missing starters: ${r.missing.join(',')} (${r.thin})`, r.tag);
  }
}
const ms = Number(process.hrtime.bigint() - t0) / 1e6;

console.log(`${N} drafts in ${ms.toFixed(0)}ms (${(ms / N).toFixed(1)}ms each)`);
console.log(`incomplete lineups (engine's fault): ${incomplete}/${N}`);
console.log(`drafts that ran the ADP board dry:    ${exhausted}/${N}  (more picks than players)`);
if (violations.length) {
  console.log(`\n${violations.length} VIOLATIONS:`);
  for (const v of violations.slice(0, 25)) console.log('  - ' + v);
  process.exit(1);
}
console.log('no violations');
