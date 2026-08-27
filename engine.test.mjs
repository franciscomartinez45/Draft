import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as E from './engine.mjs';

const DATA = JSON.parse(readFileSync('./adp-data.json', 'utf8'));
const PPR = E.computeTiers(DATA.formats.ppr.players.map((p) => ({ ...p })));
const IDX = E.buildIndex(PPR);
const byName = (n) => PPR.find((p) => p.name === n);

// ------------------------------------------------------------ name matching

test('normalizeName handles the real hazards in this dataset', () => {
  assert.equal(E.normalizeName('Ja’Marr Chase'), 'jamarr chase');
  assert.equal(E.normalizeName("Ja'Marr Chase"), 'jamarr chase');
  assert.equal(E.normalizeName('A.J. Brown'), 'aj brown');
  assert.equal(E.normalizeName('Amon-Ra St. Brown'), 'amon ra st brown');
  assert.equal(E.normalizeName('Jaxon Smith-Njigba'), 'jaxon smith njigba');
  assert.equal(E.normalizeName('Travis Etienne Jr.'), 'travis etienne');
  assert.equal(E.normalizeName('James Cook III'), 'james cook');
  assert.equal(E.normalizeName('Kyle Pitts Sr.'), 'kyle pitts');
  assert.equal(E.normalizeName('Eddy Piñeiro'), 'eddy pineiro'); // diacritic
  assert.equal(E.normalizeName('  MARVIN   harrison jr  '), 'marvin harrison');
});

test('typing a surname resolves to exactly one player', () => {
  for (const [q, want] of [
    ['gibbs', 'Jahmyr Gibbs'],
    ['jamarr', "Ja'Marr Chase"],
    ["ja'marr chase", "Ja'Marr Chase"],
    ['smith-njigba', 'Jaxon Smith-Njigba'],
    ['nacua', 'Puka Nacua'],
    ['pineiro', 'Eddy Piñeiro'],
  ]) {
    const r = E.matchName(q, IDX);
    assert.equal(r.status, 'one', `${q} -> ${r.status} (${r.matches.map((m) => m.name)})`);
    assert.equal(r.matches[0].name, want);
  }
});

test('ambiguous input NEVER auto-picks', () => {
  const r = E.matchName('brown', IDX);
  assert.equal(r.status, 'many');
  assert.ok(r.matches.length > 1);
  // must include several distinct Browns
  assert.ok(new Set(r.matches.map((m) => m.name)).size > 1);
});

test('defense aliases: city, nickname, abbreviation', () => {
  for (const q of ['seattle', 'seahawks', 'sea dst', 'seattle defense', 'sea d/st']) {
    const r = E.matchName(q, IDX);
    assert.equal(r.status, 'one', `${q} -> ${r.status}`);
    assert.equal(r.matches[0].name, 'Seattle Defense');
  }
});

test('typo tolerance', () => {
  const r = E.matchName('gibbss', IDX);
  assert.equal(r.status, 'one');
  assert.equal(r.matches[0].name, 'Jahmyr Gibbs');
});

test('matching respects the remaining pool', () => {
  const pool = PPR.filter((p) => p.name !== 'Jahmyr Gibbs');
  assert.equal(E.matchName('gibbs', IDX, { pool }).status, 'none');
});

// -------------------------------------------------------------------- tiers

test('tiers are monotone in ADP and non-trivial', () => {
  for (const pos of ['QB', 'RB', 'WR', 'TE']) {
    const list = PPR.filter((p) => p.pos === pos).sort((a, b) => a.adp - b.adp);
    let last = 0;
    for (const p of list) {
      assert.ok(p.tier >= last, `${pos} tiers must not go backwards`);
      last = p.tier;
    }
    assert.ok(last > 1 && last < list.length, `${pos}: ${last} tiers for ${list.length} players`);
  }
});

// ------------------------------------------------------------------- snake

test('snake pick numbers', () => {
  assert.deepEqual(E.snakePicks(12, 1, 4), [1, 24, 25, 48]);
  assert.deepEqual(E.snakePicks(12, 12, 4), [12, 13, 36, 37]);
  assert.deepEqual(E.snakePicks(10, 5, 3), [5, 16, 25]);
  assert.equal(E.nextPickAfter(31, E.snakePicks(12, 1, 16)), 48);
});

// ------------------------------------------------------ availability guards

test('cdfAvailability never returns NaN, even on degenerate input', () => {
  const junk = [
    { adp: 5, stdev: 0, high: 5, low: 5, n: 1 },
    { adp: 5, stdev: null, high: null, low: null, n: null },
    { adp: 190, stdev: undefined, high: 180, low: 200, n: 5 },
  ];
  for (const p of junk) {
    for (const pick of [1, 12, 50, 300]) {
      const v = E.cdfAvailability(p, pick);
      assert.ok(Number.isFinite(v), `NaN for ${JSON.stringify(p)} @${pick}`);
      assert.ok(v >= 0 && v <= 1);
    }
  }
});

test('no probability mass before a player has ever been drafted', () => {
  const gibbs = byName('Jahmyr Gibbs'); // adp 1.5, stdev 0.7, high 1
  assert.equal(E.cdfAvailability(gibbs, 1), 1, 'must be 100% available at pick 1');
  assert.ok(E.cdfAvailability(gibbs, 12) < 0.02, 'must be long gone by pick 12');
});

test('low sample size widens the distribution', () => {
  const a = { adp: 100, stdev: 10, high: 80, low: 120, n: 3000 };
  const b = { adp: 100, stdev: 10, high: 80, low: 120, n: 5 };
  assert.ok(E.effectiveStdev(b) > 2 * E.effectiveStdev(a));
});

test('geometric blend: a confident live estimate is not washed out by the prior', () => {
  // arithmetic averaging at w=.6 would give .6*.01 + .4*.9 = .37 -- far too high
  assert.ok(E.blendProb(0.01, 0.9, 0.6) < 0.12);
  assert.ok(E.blendProb(0.9, 0.9, 0.6) > 0.85);
  assert.ok(Number.isFinite(E.blendProb(0, 1, 0.5)));
  assert.ok(Number.isFinite(E.blendProb(NaN, NaN, 0.5)));
});

test('positional divergence stays silent without evidence', () => {
  assert.equal(E.positionalDivergence(PPR, [], 17), 0, 'no picks yet = no run');
  assert.equal(E.positionalDivergence(PPR, PPR.slice(0, 2), 17), 0, 'two picks prove nothing');
  const rbs = PPR.filter((p) => p.pos === 'RB').slice(0, 12);
  assert.ok(E.positionalDivergence(PPR, rbs, 17) > 0.3, 'but 12 straight RBs is a run');
});

test('blendWeight hits its pinned endpoints', () => {
  assert.equal(E.blendWeight(0), 0.35);
  assert.ok(Math.abs(E.blendWeight(8) - 0.7) < 1e-9);
  assert.equal(E.blendWeight(15), 0.95);
  assert.equal(E.blendWeight(999), 0.95);
  assert.ok(E.blendWeight(4) > 0.35 && E.blendWeight(4) < 0.7);
});

test('positionalSurvival: more expected picks at a position -> less survival', () => {
  assert.ok(E.positionalSurvival(0, 12) < 0.01, 'top RB gone if 12 RBs will go');
  assert.ok(E.positionalSurvival(0, 0.2) > 0.8, 'and safe if almost none will');
  // monotone decreasing in mu, increasing in j
  assert.ok(E.positionalSurvival(3, 2) > E.positionalSurvival(3, 8));
  assert.ok(E.positionalSurvival(5, 4) > E.positionalSurvival(1, 4));
  assert.equal(E.poissonCdf(0, 0), 1);
  for (const [j, mu] of [[0, 0], [5, 40], [2, -1], [0, 1e6]]) {
    assert.ok(Number.isFinite(E.poissonCdf(j, mu)));
  }
});

test('positionalRates detects a run the overall pool rank cannot', () => {
  const rbs = PPR.filter((p) => p.pos === 'RB').slice(0, 12);
  const wrs = PPR.filter((p) => p.pos === 'WR').slice(0, 12);
  const pool = PPR.filter((p) => !rbs.includes(p) && !wrs.includes(p));
  const afterRbRun = E.positionalRates(pool, rbs, 17);
  const afterWrRun = E.positionalRates(pool, wrs, 17);
  assert.ok(afterRbRun.RB > afterWrRun.RB * 2, 'RB demand must spike after an RB run');
  assert.ok(afterWrRun.WR > afterRbRun.WR * 2, 'and symmetrically for WR');
});

// ---------------------------------------------------------- roster / need

test('K and DEF are suppressed until the endgame', () => {
  const r = {}, L = E.DEFAULT_LINEUP;
  assert.ok(E.positionNeed('K', r, L, 10, 24, 12) < 0.05, 'no kickers in round 6');
  assert.ok(E.positionNeed('DEF', r, L, 10, 24, 12) < 0.05);
  assert.ok(E.positionNeed('K', r, L, 2, 24, 12) > 2, 'but grab one at the end');
  assert.equal(E.positionNeed('K', { K: 1 }, L, 1, 24, 12), 0.01, 'never a second kicker');
});

test('K/DEF scarcity only matters in the endgame', () => {
  const r = {}, L = E.DEFAULT_LINEUP;
  // Scarcity mid-draft is irrelevant -- reacting to it is how you get a round-8 kicker.
  assert.ok(E.positionNeed('K', r, L, 8, 5, 14) < 0.05, '8 rounds left -> ignore even if scarce');
  assert.ok(E.positionNeed('K', r, L, 6, 5, 14) < 0.05, 'still too early at 6');
  // Inside the endgame, supply drives urgency.
  assert.ok(E.positionNeed('K', r, L, 4, 18, 14) < 0.05, 'endgame but ample -> still wait');
  assert.ok(E.positionNeed('K', r, L, 4, 12, 14) > 1, 'endgame + thinning -> take one');
  assert.ok(E.positionNeed('K', r, L, 4, 6, 14) > 2, 'endgame + critical -> act now');
  // and it must never outrank a real starter
  const kicker = E.adpValue(160) * E.positionNeed('K', r, L, 4, 6, 14);
  const rb = E.adpValue(90) * E.positionNeed('RB', r, L, 4, 50, 14);
  assert.ok(rb > kicker, 'a startable RB still beats a scarce kicker');
});

test('need falls once starting slots are filled', () => {
  const L = E.DEFAULT_LINEUP;
  const empty = E.positionNeed('RB', {}, L, 10);
  const starters = E.positionNeed('RB', { RB: 2, WR: 2, TE: 1 }, L, 10);
  const flexFilled = E.positionNeed('RB', { RB: 3, WR: 2, TE: 1 }, L, 10);
  assert.ok(empty > starters, 'filling RB slots lowers need');
  assert.ok(starters > flexFilled, 'an open FLEX still wants RBs');
  assert.ok(flexFilled < 0.6, 'depth-only RB should be cheap');
});

test('superflex makes a second QB a starter', () => {
  const L = { ...E.DEFAULT_LINEUP, SUPERFLEX: 1 };
  assert.ok(E.positionNeed('QB', { QB: 1 }, L, 10) > 1);
  assert.ok(E.positionNeed('QB', { QB: 1 }, E.DEFAULT_LINEUP, 10) < 0.5);
});

// =====================================================================
// THE FALSIFICATION TEST -- the whole reason the model isn't a bare CDF.
// Hand-built fixture: fixed drafted list, fixed pick, asserted number.
// =====================================================================

/**
 * 30 picks made, my next pick 17 away. The first 18 are identical chalk; the
 * last 12 all go to `runPos`. Comparing runPos='RB' vs 'WR' isolates the run
 * effect -- both boards have the same number of players gone, so any change in
 * RB survival comes purely from positional demand.
 */
function scenario(runPos) {
  const pool = PPR.map((p) => ({ ...p }));
  const drafted = new Set();
  const order = [];
  const take = (p) => { drafted.add(p.id); order.push(p); };

  const chalk = pool.filter((p) => !['K', 'DEF'].includes(p.pos)).sort((a, b) => a.adp - b.adp);
  for (const p of chalk.slice(0, 18)) take(p);
  const run = chalk.filter((p) => p.pos === runPos && !drafted.has(p.id));
  for (const p of run.slice(0, 12)) take(p);
  assert.equal(order.length, 30);

  return {
    players: pool, drafted, draftedOrder: order, roster: {},
    lineup: E.DEFAULT_LINEUP, leagueSize: 12, slot: 1, rounds: 16,
  };
}

test('RUN-AWARE: 12 straight RBs must collapse RB survival', () => {
  const rbRun = E.evaluate(scenario('RB'));
  const wrRun = E.evaluate(scenario('WR'));
  assert.equal(rbRun.gap, 17, 'fixture must put my next pick 17 away');
  assert.equal(wrRun.gap, 17);

  // Apples to apples: the RBs still on the board in BOTH scenarios.
  const inBoth = rbRun.available
    .filter((p) => p.pos === 'RB' && wrRun.available.some((q) => q.id === p.id))
    .slice(0, 6);
  assert.ok(inBoth.length >= 4, 'need a shared set of RBs to compare');
  const sum = (ev) => inBoth.reduce((s, p) => s + ev.avail.get(p.id), 0);

  console.log(
    `    same ${inBoth.length} RBs -- after a 12-RB run: ${sum(rbRun).toFixed(2)} survive; ` +
    `after a 12-WR run: ${sum(wrRun).toFixed(2)} survive`
  );
  assert.ok(
    sum(rbRun) < sum(wrRun) / 2,
    `an RB run must slash RB survival: ${sum(rbRun).toFixed(2)} vs ${sum(wrRun).toFixed(2)}`
  );

  // The assertion the plan committed to: the live RB tier cannot be counted on.
  const bestRB = rbRun.available.find((p) => p.pos === 'RB');
  const tier = rbRun.available.filter((p) => p.pos === 'RB' && p.tier === bestRB.tier);
  const survivors = tier.reduce((s, p) => s + rbRun.avail.get(p.id), 0);
  console.log(`    current RB tier ${bestRB.tier} (${tier.length} players) -> ${survivors.toFixed(2)} expected to survive`);
  assert.ok(survivors < 1, `expected survivors must be < 1, got ${survivors.toFixed(2)}`);
});

test('a pure-CDF model is blind to the run (proves the live signal is load-bearing)', () => {
  const rbRun = E.evaluate(scenario('RB'));
  const wrRun = E.evaluate(scenario('WR'));
  const inBoth = rbRun.available
    .filter((p) => p.pos === 'RB' && wrRun.available.some((q) => q.id === p.id))
    .slice(0, 6);
  const cdfRb = inBoth.reduce((s, p) => s + E.cdfAvailability(p, rbRun.horizon), 0);
  const cdfWr = inBoth.reduce((s, p) => s + E.cdfAvailability(p, wrRun.horizon), 0);
  console.log(`    CDF-only: ${cdfRb.toFixed(2)} vs ${cdfWr.toFixed(2)} -- identical, it cannot see the run`);
  assert.ok(Math.abs(cdfRb - cdfWr) < 1e-9, 'the naive model gives the same answer either way');
  assert.ok(cdfRb > 1, 'and it is materially wrong about the RB-run board');
});

// --------------------------------------------------------- recommendations

test('recommendations are sane and explained', () => {
  const empty = {
    players: PPR.map((p) => ({ ...p })), drafted: new Set(), draftedOrder: [],
    roster: {}, lineup: E.DEFAULT_LINEUP, leagueSize: 12, slot: 1, rounds: 16,
  };
  const { top } = E.recommend(empty, 3);
  assert.equal(top.length, 3);
  for (const t of top) {
    assert.ok(Number.isFinite(t.score) && t.score > 0);
    assert.ok(!['K', 'DEF'].includes(t.player.pos), 'never K/DEF in round 1');
    assert.ok(t.player.adp < 30, `round-1 pick should be a round-1 player, got ${t.player.name}`);
    assert.ok(t.reasons.length > 0);
  }
});

test('the urgency stripe and the reason text can never contradict each other', () => {
  // Both must come from URGENCY. Independent thresholds drift apart silently and
  // produce a card that says "gone by your turn" above "you can wait".
  for (const runPos of ['RB', 'WR']) {
    const ev = E.evaluate(scenario(runPos));
    for (const row of ev.scored) {
      const band = E.urgencyBand(row.pAvail, ev.gap);
      const reasons = E.explain(row, ev).join(' ');
      if (band === 'now') {
        assert.ok(!/you can wait/.test(reasons),
          `${row.player.name}: stripe says gone, reason says wait (p=${row.pAvail.toFixed(2)})`);
      }
      if (band === 'wait' && ev.gap > 0) {
        assert.ok(!/almost certainly gone/.test(reasons),
          `${row.player.name}: stripe says wait, reason says gone (p=${row.pAvail.toFixed(2)})`);
      }
    }
  }
  assert.equal(E.urgencyBand(0.9, 0), 'wait', 'no gap means nothing is urgent');
  assert.equal(E.urgencyBand(E.URGENCY.NOW, 10), 'now');
  assert.equal(E.urgencyBand(E.URGENCY.SOON, 10), 'soon');
  assert.equal(E.urgencyBand(0.99, 10), 'wait');
});

test('every player on the board scores finite', () => {
  const state = scenario('RB');
  const ev = E.evaluate(state);
  assert.equal(ev.scored.length, ev.available.length);
  for (const r of ev.scored) {
    assert.ok(Number.isFinite(r.score), `${r.player.name} scored ${r.score}`);
    assert.ok(Number.isFinite(r.pAvail) && r.pAvail >= 0 && r.pAvail <= 1);
  }
});
