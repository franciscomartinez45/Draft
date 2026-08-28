// Pure draft logic. No DOM, no I/O -- imported by tests/simulator and inlined
// verbatim into index.html by build.mjs (which strips the `export ` keywords).

// ---------------------------------------------------------------- constants

export const NICKNAMES = {
  ARI: 'cardinals', ATL: 'falcons', BAL: 'ravens', BUF: 'bills',
  CAR: 'panthers', CHI: 'bears', CIN: 'bengals', CLE: 'browns',
  DAL: 'cowboys', DEN: 'broncos', DET: 'lions', GB: 'packers',
  HOU: 'texans', IND: 'colts', JAX: 'jaguars', KC: 'chiefs',
  LAC: 'chargers', LAR: 'rams', LV: 'raiders', MIA: 'dolphins',
  MIN: 'vikings', NE: 'patriots', NO: 'saints', NYG: 'giants',
  NYJ: 'jets', PHI: 'eagles', PIT: 'steelers', SEA: 'seahawks',
  SF: '49ers', TB: 'buccaneers', TEN: 'titans', WAS: 'commanders',
};

export const DEFAULT_LINEUP = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, K: 1, DEF: 1 };
export const FLEX_POS = ['RB', 'WR', 'TE'];
// how many bench players at a position are actually useful
export const BENCH_ALLOWANCE = { QB: 1, RB: 3, WR: 3, TE: 1 };

// ------------------------------------------------------------ name matching

const SUFFIXES = /\b(jr|sr|ii|iii|iv|v)\b/g;

/** lowercase, strip diacritics/punctuation/suffixes, collapse whitespace. */
export function normalizeName(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')   // Piñeiro -> Pineiro
    .toLowerCase()
    .replace(/[.'`’]/g, '')            // A.J. -> aj, Ja'Marr -> jamarr
    .replace(/[-_/]/g, ' ')            // Smith-Njigba -> smith njigba
    .replace(SUFFIXES, ' ')            // Travis Etienne Jr. -> travis etienne
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Every string a user might plausibly type for this player. */
export function aliasesFor(p) {
  const out = new Set([normalizeName(p.name)]);
  if (p.pos === 'DEF') {
    const city = normalizeName(p.name.replace(/\s*defense\s*$/i, ''));
    const nick = NICKNAMES[p.team];
    const ab = normalizeName(p.team);
    for (const base of [city, nick, ab].filter(Boolean)) {
      out.add(base);
      out.add(`${base} defense`);
      out.add(`${base} dst`);
      out.add(`${base} d st`);
      out.add(`${base} def`);
      out.add(`${base} d`);
    }
    if (nick && city) out.add(`${city} ${nick}`);
  } else {
    const n = normalizeName(p.name);
    const parts = n.split(' ');
    if (parts.length > 1) {
      // "last, first" and initial+last: "j chase"
      out.add(`${parts.slice(1).join(' ')} ${parts[0]}`);
      out.add(`${parts[0][0]} ${parts.slice(1).join(' ')}`);
    }
  }
  return [...out].filter(Boolean);
}

export function buildIndex(players) {
  const byAlias = new Map(); // alias -> [player, ...]
  for (const p of players) {
    for (const a of aliasesFor(p)) {
      if (!byAlias.has(a)) byAlias.set(a, []);
      if (!byAlias.get(a).includes(p)) byAlias.get(a).push(p);
    }
  }
  return { players, byAlias };
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > 2) return 99; // we only care about <=2
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(
        prev[j] + 1,
        cur[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Resolve typed text to players.
 * Returns { status: 'none'|'one'|'many', matches: [...] }.
 * NEVER auto-picks between several candidates -- crossing out the wrong player
 * and not noticing is the worst failure this tool can have.
 */
export function matchName(query, index, { pool = null, limit = 8 } = {}) {
  const q = normalizeName(query);
  if (!q) return { status: 'none', matches: [] };
  const live = pool ? new Set(pool.map((p) => p.id)) : null;
  const ok = (p) => !live || live.has(p.id);
  const uniq = (arr) => [...new Set(arr)].filter(ok);

  // 1. exact alias
  const exact = uniq(index.byAlias.get(q) ?? []);
  if (exact.length === 1) return { status: 'one', matches: exact };
  if (exact.length > 1) return { status: 'many', matches: exact.slice(0, limit) };

  // 2. alias prefix / word-boundary containment
  const pre = [];
  for (const [alias, ps] of index.byAlias) {
    if (alias.startsWith(q) || alias.includes(` ${q}`)) pre.push(...ps);
  }
  const preU = uniq(pre);
  if (preU.length === 1) return { status: 'one', matches: preU };
  if (preU.length > 1) {
    preU.sort((a, b) => a.adp - b.adp);
    return { status: 'many', matches: preU.slice(0, limit) };
  }

  // 3. fuzzy: typo tolerance on full name or surname
  const fuzzy = [];
  for (const p of index.players) {
    if (!ok(p)) continue;
    const n = normalizeName(p.name);
    const surname = n.split(' ').slice(1).join(' ') || n;
    if (levenshtein(q, n) <= 2 || levenshtein(q, surname) <= 2) fuzzy.push(p);
  }
  const fz = uniq(fuzzy);
  if (fz.length === 1) return { status: 'one', matches: fz };
  if (fz.length > 1) {
    fz.sort((a, b) => a.adp - b.adp);
    return { status: 'many', matches: fz.slice(0, limit) };
  }
  return { status: 'none', matches: [] };
}

// -------------------------------------------------------------------- tiers

/**
 * Group each position into tiers by ADP gaps. Tiers are what a novice actually
 * needs: "these are interchangeable -- if you miss one, take the next".
 * Mutates players, adding .tier (1-based within position).
 */
export const MAX_TIER_SIZE = 8;

export function computeTiers(players) {
  const byPos = new Map();
  for (const p of players) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }
  for (const [, list] of byPos) {
    list.sort((a, b) => a.adp - b.adp);
    let tier = 1;
    let size = 0;
    for (let i = 0; i < list.length; i++) {
      if (i > 0) {
        const gap = list[i].adp - list[i - 1].adp;
        // Relative threshold: gaps grow with draft position, so a fixed cutoff
        // lumps the entire first round into one tier and shreds the late rounds.
        const threshold = Math.max(2.5, 0.15 * list[i - 1].adp);
        if (gap > threshold || size >= MAX_TIER_SIZE) {
          tier++;
          size = 0;
        }
      }
      list[i].tier = tier;
      size++;
    }
  }
  return players;
}

// ------------------------------------------------------------- snake drafts

/** 1-indexed overall pick numbers for `slot` in a snake draft. */
export function snakePicks(leagueSize, slot, rounds) {
  const picks = [];
  for (let r = 1; r <= rounds; r++) {
    const inRound = r % 2 === 1 ? slot : leagueSize - slot + 1;
    picks.push((r - 1) * leagueSize + inRound);
  }
  return picks;
}

export function nextPickAfter(currentPick, picks) {
  return picks.find((p) => p >= currentPick) ?? null;
}

/**
 * Which slot owns overall pick `pick`. The exact inverse of snakePicks -- it is
 * what pre-selects a chip in the slot chooser, so a drift between the two would
 * attribute picks to the wrong team without ever looking broken.
 */
export function snakeTeamForPick(pick, leagueSize) {
  const r = Math.ceil(pick / leagueSize);
  const i = pick - (r - 1) * leagueSize;
  return r % 2 === 1 ? i : leagueSize - i + 1;
}

// ------------------------------------------------------- availability model

/** Abramowitz & Stegun 7.1.26 */
function erf(x) {
  const s = Math.sign(x);
  x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return s * y;
}
const Phi = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Sample-size-aware spread. A player seen in 5 mocks is far less pinned down. */
export function effectiveStdev(p) {
  const base = Math.max(Number(p.stdev) || 0, 1.0);           // guard null/0 -> NaN board
  const n = Math.max(Number(p.n) || 1, 1);
  return base * Math.sqrt(1 + 200 / n);
}

/** P(still on the board at `pick`) from ADP priors alone, truncated to [high,low]. */
export function cdfAvailability(p, pick) {
  const sd = effectiveStdev(p);
  const lo = Math.max(1, (Number(p.high) || p.adp) - sd);  // earliest ever taken
  const hi = (Number(p.low) || p.adp) + sd;                // latest ever taken
  if (pick <= lo) return 1;
  if (pick >= hi) return 0;
  const F = (x) => Phi((x - p.adp) / sd);
  const denom = F(hi) - F(lo);
  if (!(denom > 1e-9)) return pick <= p.adp ? 1 : 0;
  return Math.min(1, Math.max(0, (F(hi) - F(pick)) / denom));
}

/** P(Poisson(mu) <= j) -- computed iteratively so it can't overflow. */
export function poissonCdf(j, mu) {
  if (!(mu > 0)) return 1;
  if (j < 0) return 0;
  let term = Math.exp(-mu);
  let sum = term;
  for (let i = 1; i <= j; i++) {
    term *= mu / i;
    sum += term;
  }
  return Math.min(1, Math.max(0, sum));
}

/**
 * How many of the next `gap` picks will be spent on each position.
 *
 * This is what makes the model run-aware. A purely rank-based signal CANNOT
 * distinguish an RB run from a WR run -- removing 12 players shifts every
 * remaining player's overall rank by 12 either way. Positional demand is the
 * signal that actually moves when the room stampedes one position.
 *
 * Blends what the room is ACTUALLY doing (recent picks) against what ADP says
 * SHOULD happen (position mix of the next `gap` players on the board).
 */
export function positionalRates(available, draftedOrder, gap) {
  const K = Math.min(draftedOrder.length, 12);
  const recent = draftedOrder.slice(-K);
  const alpha = K / (K + 8); // shrinkage: trust observation more as evidence grows

  const obs = {};
  for (const p of recent) obs[p.pos] = (obs[p.pos] || 0) + 1;

  const horizon = available.slice(0, Math.max(gap, 1));
  const pri = {};
  for (const p of horizon) pri[p.pos] = (pri[p.pos] || 0) + 1;

  const rates = {};
  const positions = new Set([...Object.keys(obs), ...Object.keys(pri)]);
  for (const pos of positions) {
    const o = recent.length ? (obs[pos] || 0) / recent.length : 0;
    const q = horizon.length ? (pri[pos] || 0) / horizon.length : 0;
    rates[pos] = alpha * o + (1 - alpha) * q;
  }
  return rates;
}

/**
 * P(the j-th-best remaining player at a position survives), given that `mu`
 * picks at that position are expected before my turn. He survives iff at most
 * j players at his position are taken.
 */
export function positionalSurvival(j, mu) {
  return poissonCdf(j, mu);
}

/**
 * How far the room has strayed from consensus: mean |actual pick - adp|.
 * Drives how much we trust live observation over the priors.
 */
export function boardDeviation(draftedInOrder) {
  const scored = draftedInOrder
    .map((p, i) => (Number.isFinite(p?.adp) ? Math.abs(i + 1 - p.adp) : null))
    .filter((v) => v !== null);
  if (!scored.length) return 0;
  return scored.reduce((s, v) => s + v, 0) / scored.length;
}

/**
 * Total-variation distance between the position mix the room is ACTUALLY
 * taking and the mix ADP predicts. This -- not global ADP deviation -- is the
 * thing that specifically invalidates a per-player ADP estimate: a room can run
 * on RBs while every individual pick still lands near its ADP.
 * Shrunk toward 0 when there is little evidence yet.
 */
export function positionalDivergence(available, draftedOrder, gap) {
  const K = Math.min(draftedOrder.length, 12);
  if (K < 4) return 0; // not enough evidence to call anything a run
  const recent = draftedOrder.slice(-K);
  const horizon = available.slice(0, Math.max(gap, 1));
  if (!horizon.length) return 0;

  const share = (arr) => {
    const m = {};
    for (const p of arr) m[p.pos] = (m[p.pos] || 0) + 1 / arr.length;
    return m;
  };
  const o = share(recent);
  const q = share(horizon);
  let tv = 0;
  for (const pos of new Set([...Object.keys(o), ...Object.keys(q)])) {
    tv += Math.abs((o[pos] || 0) - (q[pos] || 0));
  }
  return (tv / 2) * (K / (K + 6));
}

/**
 * Single "how much should I distrust ADP" score on the pick-deviation scale the
 * blend endpoints are pinned to. Takes whichever signal is screaming louder:
 * reaches/falls on individual players, or a positional run.
 */
export function divergenceScore(draftedOrder, posDiv) {
  return Math.max(boardDeviation(draftedOrder), 20 * Math.max(0, posDiv - 0.15));
}

/**
 * Log-opinion-pool (geometric) blend of two probability estimates.
 * Averaging arithmetically lets a confident-but-stale prior drag a near-zero
 * live estimate back up -- exactly the failure this model exists to avoid.
 */
export function blendProb(live, prior, w) {
  const c = (x) => Math.min(0.995, Math.max(0.005, Number.isFinite(x) ? x : 0.5));
  return Math.exp(w * Math.log(c(live)) + (1 - w) * Math.log(c(prior)));
}

/** Piecewise-linear: 0 dev -> .35, 8 -> .70, >=15 -> .95. Clamped [.35,.95]. */
export function blendWeight(dev) {
  const pts = [[0, 0.35], [8, 0.7], [15, 0.95]];
  if (dev <= pts[0][0]) return pts[0][1];
  if (dev >= pts[2][0]) return pts[2][1];
  for (let i = 1; i < pts.length; i++) {
    const [x0, y0] = pts[i - 1];
    const [x1, y1] = pts[i];
    if (dev <= x1) return y0 + ((dev - x0) / (x1 - x0)) * (y1 - y0);
  }
  return 0.95;
}

// ------------------------------------------------------------- value & need

/** Convex decay in ADP. Only relative gaps matter. */
export function adpValue(adp) {
  return 100 / (1 + Math.pow(Math.max(adp, 0.5) / 18, 0.85));
}

/**
 * Positional need multiplier from unfilled STARTING slots.
 * K/DEF are suppressed until the endgame -- drafting a kicker in round 8 is the
 * single most common novice mistake.
 */
export function positionNeed(pos, roster, lineup, roundsLeft, supply = Infinity, leagueSize = 12) {
  const have = (p) => roster[p] || 0;

  if (pos === 'K' || pos === 'DEF') {
    if (have(pos) >= (lineup[pos] || 0)) return 0.01;
    if (roundsLeft <= 2) return 3.0;
    // Supply-aware, not just round-aware: half-PPR lists only 18 kickers, so in
    // a 14-team league waiting for the literal last pick can leave you with none.
    // Gated to the endgame -- scarcity in round 8 is irrelevant when you still
    // have 9 picks, and reacting to it is how you end up with a round-8 kicker.
    if (roundsLeft <= 5) {
      if (supply <= leagueSize * 0.5) return 2.5;  // about to be shut out
      if (supply < leagueSize) return 1.2;         // thinning, take one if cheap
    }
    return 0.005;                                  // otherwise never reach
  }

  const sf = lineup.SUPERFLEX || 0;
  const direct = Math.max(0, (lineup[pos] || 0) - have(pos));

  // Unfilled FLEX still wants RB/WR/TE bodies.
  let flexNeed = 0;
  if (FLEX_POS.includes(pos)) {
    const surplus = FLEX_POS.reduce((s, q) => s + Math.max(0, have(q) - (lineup[q] || 0)), 0);
    flexNeed = Math.max(0, (lineup.FLEX || 0) - surplus);
  }

  // Superflex/2QB makes a second QB a starter, not a luxury.
  let sfNeed = 0;
  if (pos === 'QB') sfNeed = Math.max(0, sf - Math.max(0, have('QB') - (lineup.QB || 0)));

  // Depth damper, applied on EVERY path. Without it the engine happily takes a
  // 4th QB or TE because the tier math says value is falling -- true, and
  // irrelevant: he will never start.
  const startingSlots = (lineup[pos] || 0) + (pos === 'QB' ? sf : 0) + (flexNeed > 0 ? 0 : 1);
  const bench = Math.max(0, have(pos) - startingSlots);
  const allow = BENCH_ALLOWANCE[pos] ?? 2;
  const damp = bench >= allow ? 0.05 : Math.pow(0.55, bench);

  if (direct > 0) return 1 + 0.7 * direct + 0.3 * flexNeed;
  if (sfNeed > 0) return 1 + 0.55 * sfNeed;
  if (flexNeed > 0) return (0.9 + 0.3 * flexNeed) * damp;
  return (pos === 'QB' ? 0.35 : 0.55) * damp; // depth only
}

// ---------------------------------------------------------- recommendations

/**
 * Expected value of the BEST player at `pos` still there at my next pick:
 *   sum_i value(p_i) * P(p_i survives) * prod_{j<i} P(p_j gone)
 */
export function expectedBestNext(list, avail) {
  let carry = 1;
  let ev = 0;
  for (const p of list) {
    const a = avail.get(p.id) ?? 0;
    ev += adpValue(p.adp) * a * carry;
    carry *= 1 - a;
    if (carry < 1e-4) break;
  }
  return ev;
}

/**
 * The whole board, evaluated. Returns per-player scores, tier survival, the
 * positional cliff, and plain-English reasons.
 *
 * state: { players, drafted:Set<id>, draftedOrder:[player], roster:{pos:n},
 *          lineup, leagueSize, slot, rounds }
 */
export function evaluate(state) {
  const {
    players, drafted, draftedOrder = [], roster = {},
    lineup = DEFAULT_LINEUP, leagueSize = 12, slot = 1, rounds = 16,
  } = state;

  const available = players.filter((p) => !drafted.has(p.id));
  available.sort((a, b) => a.adp - b.adp);

  const currentPick = draftedOrder.length + 1;
  const myPicks = snakePicks(leagueSize, slot, rounds);
  const nextPick = nextPickAfter(currentPick, myPicks);
  const onTheClock = nextPick === currentPick;
  const followingPick = myPicks.find((p) => p > currentPick) ?? null;
  // If I'm picking now, "can I wait?" means waiting until my FOLLOWING pick.
  const horizon = onTheClock ? followingPick : nextPick;
  const gap = horizon ? horizon - currentPick : 0;

  const dev = boardDeviation(draftedOrder);

  // group by position (ADP order preserved)
  const byPos = new Map();
  for (const p of available) {
    if (!byPos.has(p.pos)) byPos.set(p.pos, []);
    byPos.get(p.pos).push(p);
  }

  // P(available at my horizon pick) for every remaining player.
  // Live signal is POSITIONAL demand -- that is what moves during a run.
  const rates = positionalRates(available, draftedOrder, gap);
  const posDiv = positionalDivergence(available, draftedOrder, gap);
  const w = blendWeight(divergenceScore(draftedOrder, posDiv));
  const avail = new Map();
  for (const [pos, list] of byPos) {
    const mu = (rates[pos] || 0) * gap;
    list.forEach((p, j) => {
      const live = positionalSurvival(j, mu);
      const prior = cdfAvailability(p, horizon ?? p.adp);
      avail.set(p.id, Math.min(1, Math.max(0, blendProb(live, prior, w))));
    });
  }

  const roundsLeft = rounds - (myPicks.filter((p) => p < currentPick).length);
  const posInfo = new Map();
  for (const [pos, list] of byPos) {
    posInfo.set(pos, {
      best: list[0],
      evNext: expectedBestNext(list, avail),
      need: positionNeed(pos, roster, lineup, roundsLeft, list.length, leagueSize),
      count: list.length,
    });
  }

  // recent positional run (last 10 picks)
  const recent = draftedOrder.slice(-10);
  const runs = {};
  for (const p of recent) runs[p.pos] = (runs[p.pos] || 0) + 1;

  const scored = available.map((p) => {
    const info = posInfo.get(p.pos);
    const v = adpValue(p.adp);
    const waitLoss = Math.max(0, v - info.evNext);        // cost of waiting
    const score = info.need * (v + waitLoss);

    const tierMates = byPos
      .get(p.pos)
      .filter((q) => q.tier === p.tier);
    const tierSurvivors = tierMates.reduce((s, q) => s + (avail.get(q.id) ?? 0), 0);

    return {
      player: p, score, value: v, need: info.need, waitLoss,
      pAvail: avail.get(p.id) ?? 0,
      tierSurvivors, tierSize: tierMates.length,
      isLastInTier: tierMates[tierMates.length - 1]?.id === p.id,
      posRun: runs[p.pos] || 0,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return {
    scored, available, avail, posInfo, currentPick, nextPick, horizon, gap,
    onTheClock, deviation: dev, posDivergence: posDiv, blendW: w, roundsLeft, recentRun: runs,
  };
}

/**
 * Urgency bands. The reason text and the card's colour stripe MUST derive from
 * this one table -- independent thresholds drift apart and produce a card whose
 * stripe says "gone by your turn" above a line that says "you can wait".
 */
export const URGENCY = { NOW: 0.20, SOON: 0.55, SAFE: 0.80 };
export function urgencyBand(pAvail, gap) {
  if (!gap) return 'wait';
  if (pAvail <= URGENCY.NOW) return 'now';
  if (pAvail <= URGENCY.SOON) return 'soon';
  return 'wait';
}

/**
 * Human-readable justification a non-expert can act on. Ordered by decisiveness
 * and capped -- five clauses is a wall of text at 60 seconds per pick.
 */
export function explain(row, ev, max = 3) {
  const { player: p } = row;
  const urgent = [];
  const context = [];

  if (ev.gap > 0) {
    const pct = Math.round(row.pAvail * 100);
    const band = urgencyBand(row.pAvail, ev.gap);
    if (band === 'now') urgent.push(`almost certainly gone before your next pick (~${pct}%)`);
    else if (band === 'soon') urgent.push(`only ~${pct}% chance he lasts to your next pick`);
    else if (row.pAvail >= URGENCY.SAFE) context.push(`~${pct}% likely still there next time — you can wait`);
  }

  if (row.tierSize > 1 && row.isLastInTier) {
    urgent.push(`last of the ${p.pos} tier-${p.tier} group — next tier is a real drop`);
  } else if (row.tierSize > 1 && row.tierSurvivors < 1 && ev.gap > 0) {
    urgent.push(`this ${p.pos} tier likely empties before your turn (${row.tierSurvivors.toFixed(1)} expected left)`);
  } else if (row.tierSize > 1) {
    context.push(`${p.pos} tier ${p.tier}, ${row.tierSize} interchangeable options left`);
  }

  if (row.posRun >= 4) urgent.push(`${p.pos} run: ${row.posRun} of the last 10 picks`);

  if (row.need >= 1.5) context.push(`fills a starting ${p.pos} slot`);
  else if (row.need <= 0.05) context.push(`you don't need a ${p.pos}`);

  if (row.waitLoss > 6) context.push(`steep drop-off after him at ${p.pos}`);
  if (p.bye) context.push(`bye week ${p.bye}`);

  const bits = [...urgent, ...context].slice(0, max);
  if (!bits.length) {
    bits.push(`best value left (${p.pos}${p.team ? ' · ' + p.team : ''}, ADP ${p.adp.toFixed(1)})`);
  }
  return bits;
}

export function recommend(state, n = 3) {
  const ev = evaluate(state);
  const top = ev.scored.slice(0, n).map((row) => ({ ...row, reasons: explain(row, ev) }));
  return { ...ev, top };
}
