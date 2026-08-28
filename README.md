# 2026 Draft War Room

A draft-day assistant for someone who knows how fantasy football works but not who the
players are. You mark each player as they come off the board; it tells you who to take next
and why, in plain English.

Built for a phone — it is what you will actually be holding at the table.

Live at **https://franciscomartinez45.github.io/Draft/**

## The morning of the draft

```sh
node fetch-adp.mjs && node fetch-projections.mjs && node build.mjs
git commit -am "refresh ADP" && git push
```

ADP changes daily. Skipping the refresh gives you confidently wrong advice, and the failure is
invisible — the app looks like it is working. GitHub Pages redeploys within a minute of the
push; hard-refresh on your phone if you still see the old board.

**This now runs itself.** `.github/workflows/refresh-adp.yml` does the same commands every
day at **6:00 am Pacific** (13:00 UTC) and pushes the result, so the live board is current
without anyone opening a laptop. It fetches, rebuilds, runs the tests, and only then commits — a failed fetch
publishes nothing rather than publishing a half-written board. You can also trigger it by hand
from the **Actions** tab, and the commands above still work if you want to refresh right now.

> **Before next August:** GitHub disables scheduled workflows after 60 days of repository
> inactivity. This repo goes quiet in the off-season, so check the Actions tab and confirm
> **Refresh ADP** is still enabled before you rely on it. Pushing any commit re-arms it.

Or open it locally: `open index.html`. It is a standalone HTML
document: no server, no build step at view time, no platform. Copy it to any device, email it
to yourself, or drop it on any static host.

## Using it

**First, pick your slot.** The app opens on a 1–12 grid and asks which pick you are. It is a
12-team snake draft; nothing else renders until it knows where you sit, because every
recommendation is an answer to "will he last until *your* next turn?"

**Then record picks as they happen.** Tap any player — in the top-5 lists, on the board, or
from search — and a sheet asks **who took him**. The slot whose turn it is comes
pre-selected, so the common case is one tap on Confirm. Tap a different number when picks
arrive out of order. Choosing your own slot fills a roster spot automatically.

Nothing is ever recorded without that confirmation, and nothing is attributed to a team
silently.

| | |
|---|---|
| **Picks** tab | Top 5 at each position. WR and RB are on screen; swipe for QB, TE, K, DEF. |
| **Board** tab | Everything still available, by position, with tier breaks marked. |
| **Teams** tab | All 12 rosters. Yours is pinned first. |

Search takes partial names — `gibb`, `jamarr`, `smith-njigba`, `seahawks` all resolve. If a
name is ambiguous (`brown`), it refuses to guess and makes you pick; crossing out the wrong
player silently is the worst thing this tool could do.

At a desk there are keys: `/` jumps to search, `Enter` opens the sheet for the top match,
`1`–`9` chooses among several matches, a second `Enter` confirms, `Esc` cancels, `⌘Z` undoes.

Scoring defaults to **PPR**. That and your slot, rounds, and starting lineup live behind the
gear icon. All four ADP datasets are embedded, so switching format mid-draft keeps your
recorded picks.

## Files

| File | Role |
|---|---|
| `fetch-adp.mjs` | Pulls 4 scoring formats from Fantasy Football Calculator → `adp-data.json` |
| `fetch-projections.mjs` | Pulls RotoWire season projections via Sleeper, joins to FFC ids → `projections.json` |
| `engine.mjs` | Pure logic: name matching, tiers, availability, scoring. No DOM. |
| `engine.test.mjs` | `node --test engine.test.mjs` — 31 tests |
| `simulate.mjs` | `node simulate.mjs 1000` — adversarial mock drafts |
| `smoke.mjs` | `node smoke.mjs` — runs the real page code against a DOM shim, 15 checks |
| `.github/workflows/refresh-adp.yml` | Daily ADP refresh, test, and publish |
| `template.html` | Markup, styles, UI glue |
| `build.mjs` | Inlines engine + data → `index.html` |
| `index.html` | **The deliverable.** Standalone HTML document, no server needed. |

`index.html` has the engine and all 956 player rows pasted inside it. It needs none of the
other files at runtime — they are only used to rebuild it.

Zero npm dependencies.

The only network request the page makes is to Google Fonts. Without a connection it falls back
to system fonts and every feature still works — but if you want it fully offline, the fonts can
be inlined as base64.

## How the recommendation works

Two different questions, two different data sources. Conflating them is the mistake the whole
design exists to avoid:

| Question | Source |
|---|---|
| **How good is he?** | RotoWire season projections → points over replacement |
| **Will he still be there at my next pick?** | Fantasy Football Calculator ADP |

The projections are **RotoWire's**, served through Sleeper's API — Sleeper is the pipe, not the
source. The endpoint is undocumented (Sleeper's published API covers players, leagues and drafts,
not projections), so it is free and needs no key but carries no stability promise. If it changes
shape, `fetch-projections.mjs` fails loudly rather than publishing a broken board.

`projections.json` records **when RotoWire last refreshed**, not just when we pulled — otherwise a
provider that quietly stopped updating still looks like a fresh fetch. Over 7 days it warns and
publishes anyway (week-old projections on draft morning beat no board); over 45 days it refuses.

### How good is he

Raw projected PPR points cannot be compared across positions: 300 points from a quarterback is
not worth 300 from a running back, because the 12th-best QB is nearly as good as the 5th while
the 30th RB is a cliff. So a player is worth his points *over replacement level* — replacement
being the last man who would start somewhere in a 12-team league. Flex slots are handed to
whichever position has the best body left, rather than split by a fixed ratio, because a fixed
split misplaces replacement exactly when one position is unusually deep.

Inside a position this changes nothing — replacement is a constant there, so the top-5 WR panel
is simply the five available receivers with the most projected points. It is what makes the
comparison *between* positions honest, and it is why an elite tight end outranks a receiver who
scores more raw points.

### Will he still be there

This is where ADP earns its place — it is the only signal that knows what the room will do.
The naive answer uses each player's ADP distribution. That fails exactly when advice matters
most, because it never updates as the draft deviates from consensus. Worse, a purely
rank-based fix doesn't help either — removing 12 players shifts everyone's overall rank
identically whether those 12 were running backs or receivers.

So the live signal is **positional demand**: how many picks at this position are expected
before your turn, estimated from what the room is actually doing, blended against what ADP
predicts. Survival is then `P(Poisson(μ) ≤ j)` for the j-th-best remaining player at that
position. That gets combined with the ADP prior in log-odds space, weighted by how far the
room has strayed from consensus.

`engine.test.mjs` asserts the difference on a hand-built fixture — the same six running backs,
same number of players gone:

| | after a 12-RB run | after a 12-WR run |
|---|---|---|
| this model | **0.24 survive** | 5.77 survive |
| ADP-only baseline | 5.31 | 5.31 *(blind to the run)* |

Other behavior worth knowing:

- **Tiers** come from relative ADP gaps, so a 3-pick gap at ADP 10 breaks a tier but the same
  gap at ADP 150 does not. Tiers are the actionable unit: miss one, take the next.
- **Kickers and defenses** are suppressed until the final rounds, and then only escalate if
  supply is genuinely running out.
- **Depth is damped** so it won't recommend a 4th tight end because "value is falling."
- **Who drafted whom** is recorded per slot, so the Teams tab shows all 12 rosters. It does not
  yet feed the recommendation — opponents' positional needs are not modelled.

## Known limits

- Projections are one source's opinion — RotoWire's, not a consensus the way ADP is. FantasyPros'
  aggregate or ESPN would give different numbers, and a different top five.
- They assume a full healthy season for everyone —
  a player with an injury history projects the same 17 games as an iron man. Injury risk is
  entirely absent from the model.
- ADP is consensus opinion about *when people draft*, nothing more.
- The board carries 218–267 players depending on format. A 12-team × 16-round draft needs 192
  picks, which the PPR board covers; deeper leagues can run the last rounds dry, and the app
  warns you when that will happen.
- Recommendations assume a snake draft. Auction is not supported.
- Changing your slot after picks are recorded rewrites which of them count as yours, since
  "mine" is derived from the slot. The app asks before doing it.
