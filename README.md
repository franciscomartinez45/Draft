# 2026 Draft War Room

A draft-day assistant for someone who knows how fantasy football works but not who the
players are. You mark each player as they come off the board; it tells you who to take next
and why, in plain English.

## The morning of the draft

```sh
node fetch-adp.mjs   # refresh ADP (it changes daily — do NOT skip this)
node build.mjs       # regenerate draft.html
```

Then open `draft.html` — double-click it, or `open draft.html`. It is a standalone HTML
document: no server, no build step at view time, no platform. Copy it to any device, email it
to yourself, or drop it on any static host.

## Using it

| Action | Key |
|---|---|
| Someone else drafted him | type name → `Enter` |
| **You** drafted him | type name → `Shift+Enter` |
| Choose among several matches | `1`–`9` |
| Undo | `⌘Z` |
| Jump to the search box | `/` |
| Light / dark / auto | the **Auto** button, top right |

Type partial names — `gibb`, `jamarr`, `smith-njigba`, `seahawks` all resolve. If a name is
ambiguous (`brown`), it refuses to guess and makes you pick; crossing out the wrong player
silently is the worst thing this tool could do.

Set **Teams**, **Your slot**, and **Scoring** before you start. All four ADP datasets are
embedded, so switching scoring format mid-draft keeps your recorded picks.

## Files

| File | Role |
|---|---|
| `fetch-adp.mjs` | Pulls 4 scoring formats from Fantasy Football Calculator → `adp-data.json` |
| `engine.mjs` | Pure logic: name matching, tiers, availability, scoring. No DOM. |
| `engine.test.mjs` | `node --test engine.test.mjs` — 24 tests |
| `simulate.mjs` | `node simulate.mjs 1000` — adversarial mock drafts |
| `smoke.mjs` | `node smoke.mjs` — runs the real page code against a DOM shim |
| `template.html` | Markup, styles, UI glue |
| `build.mjs` | Inlines engine + data → `draft.html` |
| `draft.html` | **The deliverable.** Standalone HTML document, no server needed. |

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

Other behavior worth knowing:

- **Tiers** come from relative ADP gaps, so a 3-pick gap at ADP 10 breaks a tier but the same
  gap at ADP 150 does not. Tiers are the actionable unit: miss one, take the next.
- **Kickers and defenses** are suppressed until the final rounds, and then only escalate if
  supply is genuinely running out. Half-PPR lists just 18 kickers, which is tight for a
  14-team league.
- **Depth is damped** so it won't recommend a 4th tight end because "value is falling."

## Known limits

- ADP is consensus opinion, not projection. It knows nothing about a Week 2 injury.
- The board carries 218–267 players depending on format. A 14-team × 16-round draft needs 224
  picks, so the last rounds can run dry — the app warns you when your league is that size.
- Recommendations assume a snake draft. Auction is not supported.
