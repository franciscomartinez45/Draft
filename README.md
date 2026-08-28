# 2026 Draft War Room

A draft-day assistant for someone who knows how fantasy football works but not who the
players are. You mark each player as they come off the board; it tells you who to take next
and why, in plain English.

Built for a phone — it is what you will actually be holding at the table.

Live at **https://franciscomartinez45.github.io/Draft/**

## The morning of the draft

```sh
node fetch-adp.mjs && node build.mjs      # refresh ADP, rebuild index.html
git commit -am "refresh ADP" && git push  # publish it
```

ADP changes daily. Skipping the refresh gives you confidently wrong advice, and the failure is
invisible — the app looks like it is working. GitHub Pages redeploys about a minute after the
push; hard-refresh on your phone if you still see the old board.

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
| `engine.mjs` | Pure logic: name matching, tiers, availability, scoring. No DOM. |
| `engine.test.mjs` | `node --test engine.test.mjs` — 26 tests |
| `simulate.mjs` | `node simulate.mjs 1000` — adversarial mock drafts |
| `smoke.mjs` | `node smoke.mjs` — runs the real page code against a DOM shim |
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

Ranking a player is mostly one question: *will he still be there at my next pick?*

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

Inside a position panel the ordering reduces to value plus the cost of waiting, so a player
about to be sniped ranks above a marginally better one who will still be there next turn.

Other behavior worth knowing:

- **Tiers** come from relative ADP gaps, so a 3-pick gap at ADP 10 breaks a tier but the same
  gap at ADP 150 does not. Tiers are the actionable unit: miss one, take the next.
- **Kickers and defenses** are suppressed until the final rounds, and then only escalate if
  supply is genuinely running out.
- **Depth is damped** so it won't recommend a 4th tight end because "value is falling."
- **Who drafted whom** is recorded per slot, so the Teams tab shows all 12 rosters. It does not
  yet feed the recommendation — opponents' positional needs are not modelled.

## Known limits

- ADP is consensus opinion, not projection. It knows nothing about a Week 2 injury.
- The board carries 218–267 players depending on format. A 12-team × 16-round draft needs 192
  picks, which the PPR board covers; deeper leagues can run the last rounds dry, and the app
  warns you when that will happen.
- Recommendations assume a snake draft. Auction is not supported.
- Changing your slot after picks are recorded rewrites which of them count as yours, since
  "mine" is derived from the slot. The app asks before doing it.
