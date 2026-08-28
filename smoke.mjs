#!/usr/bin/env node
/**
 * Executes the real inlined script from index.html against a minimal DOM shim.
 * Catches what unit tests cannot: typos, undefined identifiers, and render
 * crashes in the page code itself.
 *
 * boot() rebuilds the whole environment and re-imports a fresh copy of the app,
 * which is what makes the localStorage migration checks possible -- they need a
 * cold start against a pre-seeded blob, not a mutation of a running page.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('index.html', 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(m, 'could not find the module script in index.html');
const CODE = m[1];
const KEY = 'draft-war-room-2026';

// ------------------------------------------------------------- DOM shim
let handlers, els, docHandlers, rootAttrs, store;

function mkEl(id) {
  const el = {
    id, value: '', textContent: '', innerHTML: '', hidden: false,
    disabled: false, className: '', max: null, _h: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, on) { on ? this._s.add(c) : this._s.delete(c); },
    },
    addEventListener(ev, fn) { el._h[ev] = fn; },
    focus() {}, closest() { return null; },
    matchAll(...a) { return String(el.value).matchAll(...a); },
  };
  handlers.set(id, el._h);
  return el;
}

function makeEnv(seed) {
  handlers = new Map(); els = new Map(); docHandlers = {};
  rootAttrs = new Map(); store = new Map();
  if (seed !== undefined) store.set(KEY, JSON.stringify(seed));
  globalThis.document = {
    documentElement: {
      setAttribute: (k, v) => rootAttrs.set(k, v),
      removeAttribute: (k) => rootAttrs.delete(k),
      getAttribute: (k) => (rootAttrs.has(k) ? rootAttrs.get(k) : null),
    },
    getElementById(id) { if (!els.has(id)) els.set(id, mkEl(id)); return els.get(id); },
    addEventListener(ev, fn) { docHandlers[ev] = fn; },
    activeElement: null,
  };
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  globalThis.confirm = () => true;
}

let bootN = 0;
async function boot(seed) {
  makeEnv(seed);
  const tmp = `./.smoke-app-${++bootN}.mjs`;
  writeFileSync(tmp, CODE);
  try { await import(tmp); } finally { unlinkSync(tmp); }
}

const $ = (id) => document.getElementById(id);
const fire = (id, ev, e = {}) => handlers.get(id)?.[ev]?.({ preventDefault() {}, ...e });
const saved = () => JSON.parse(localStorage.getItem(KEY));

/** A synthetic delegated click whose target matches exactly one selector. */
function clickSel(sel, dataset = {}) {
  docHandlers.click?.({
    preventDefault() {},
    target: { closest: (s) => (s === sel ? { dataset } : null) },
  });
}
const chooseMySlot = (n) => clickSel('[data-myslot]', { myslot: String(n) });
const tapPlayer    = (id) => clickSel('[data-pick]', { pick: String(id) });
const pickSlot     = (n) => clickSel('[data-slot]', { slot: String(n) });
const confirmPick  = () => clickSel('#sheetOk');

// ====================================================================== 1
await boot();

// ---- 1. cold boot asks for a slot and does NOT run the engine
assert.ok(!$('onboard').hidden, 'a fresh load must ask which pick you are');
assert.ok($('slotGrid').innerHTML.includes('data-myslot="12"'), 'slot grid must offer 1-12');
assert.match($('clockTxt').textContent, /pick your slot/i,
  `clock before a slot is chosen: ${$('clockTxt').textContent}`);
assert.equal($('scroller').innerHTML, '', 'the scroller must stay empty until a slot exists');
console.log('cold boot asks for slot .... ok');

// ---- 2. choosing a slot brings up the whole board
chooseMySlot(4);
assert.ok($('onboard').hidden, 'onboarding should disappear once a slot is set');
assert.equal(saved().slot, 4, 'slot not persisted');
assert.ok($('scroller').innerHTML.includes('TOP') === false, 'panels are position-headed, not "TOP"');
for (const pos of ['WR', 'RB', 'QB', 'TE', 'K', 'DEF']) {
  assert.ok($('scroller').innerHTML.includes(`>${pos}<`), `no ${pos} panel in the scroller`);
}
// WR and RB lead: they must be the first two panels on the strip
const order = [...$('scroller').innerHTML.matchAll(/class="chip"[^>]*>([A-Z]+)</g)].map(x => x[1]);
assert.deepEqual(order.slice(0, 2), ['WR', 'RB'], `panel order starts ${order.slice(0, 2)}`);
// exactly five players per panel
const panelRows = $('scroller').innerHTML.split('<div class="panel">').slice(1)
  .map(s => (s.match(/class="prow/g) || []).length);
assert.ok(panelRows.every(n => n === 5), `panels held ${panelRows} rows, expected 5 each`);
assert.ok($('cols').innerHTML.includes('Tier 1'), 'board did not render tiers');
assert.ok($('slots').innerHTML.includes('QB'), 'roster slots did not render');
assert.ok($('teams').innerHTML.includes('Slot 12'), 'all 12 team cards should render');
assert.match($('clockTxt').textContent, /pick 1/i, `clock: ${$('clockTxt').textContent}`);
console.log('slot chosen, board renders . ok');

// ---- 3. search resolves, but resolving alone must NOT record anything
$('q').value = 'gibbs';
fire('q', 'input');
assert.ok($('res').innerHTML.includes('Jahmyr Gibbs'), 'suggestion list missing Gibbs');
fire('q', 'keydown', { key: 'Enter' });
assert.equal(saved().log.length, 0, 'Enter must open the slot sheet, not commit the pick');
assert.ok(!$('sheet').hidden, 'the slot sheet did not open');
assert.ok($('sheet').innerHTML.includes('Jahmyr Gibbs'), 'sheet is not about the matched player');
assert.ok($('sheet').innerHTML.includes('data-slot="12"'), 'sheet must offer all 12 slots');
// pick 1 belongs to slot 1, so that chip is pre-selected -- and slot 4 is badged YOU
assert.ok(/data-slot="1"[^>]*aria-pressed="true"/.test($('sheet').innerHTML)
  || $('sheet').innerHTML.includes('chipbtn on" data-slot="1"'), 'slot 1 not pre-selected at pick 1');
assert.ok($('sheet').innerHTML.includes('you" data-slot="4"')
  || /data-slot="4"/.test($('sheet').innerHTML), 'your own slot should be marked');
console.log('search opens the sheet ..... ok');

// ---- 4. confirming records it against the pre-selected slot, not yours
confirmPick();
assert.equal(saved().log.length, 1, 'confirm did not record the pick');
assert.equal(saved().log[0].team, 1, 'pick 1 should default to slot 1');
assert.ok(!('mine' in saved().log[0]), 'mine must be derived, never stored');
assert.ok(!$('cols').innerHTML.includes('Jahmyr Gibbs'), 'drafted player still on the board');
assert.ok($('rosterNote').textContent.startsWith('0 drafted'),
  `slot 1 is not you, roster should be empty: ${$('rosterNote').textContent}`);
console.log('confirm records the pick ... ok');

// ---- 5. choosing YOUR slot fills the roster -- this is the path that had no
//         touch equivalent before, when it needed Shift+Enter
$('q').value = 'bijan';
fire('q', 'input');
fire('q', 'keydown', { key: 'Enter' });
pickSlot(4);
confirmPick();
assert.equal(saved().log.length, 2);
assert.equal(saved().log[1].team, 4, 'explicit slot choice was ignored');
assert.ok($('rosterNote').textContent.startsWith('1 drafted'), 'roster did not count my pick');
assert.ok($('teams').innerHTML.includes('Bijan'), 'my pick is missing from the team cards');
console.log('own slot fills roster ...... ok');

// ---- 6. THE SAFETY PROPERTY: ambiguous input must never auto-commit
$('q').value = 'brown';
fire('q', 'input');
assert.ok($('res').innerHTML.includes('pick the right one'), 'no disambiguation prompt shown');
const before = saved().log.length;
fire('q', 'keydown', { key: 'Enter' });
assert.equal(saved().log.length, before, 'AMBIGUOUS INPUT WAS AUTO-COMMITTED — the worst possible bug');
assert.ok($('sheet').hidden, 'ambiguous input must not even open the sheet');
// ...but an explicit digit choice picks one, and the sheet still gates the commit
fire('q', 'keydown', { key: '2' });
assert.ok(!$('sheet').hidden, 'digit key did not select from the list');
assert.equal(saved().log.length, before, 'digit key must not commit on its own');
confirmPick();
assert.equal(saved().log.length, before + 1, 'confirming after a digit choice did not record');
console.log('ambiguity requires confirm . ok');

// ---- 7. tabs switch and persist
clickSel('[data-tab]', { tab: 'teams' });
assert.equal(saved().tab, 'teams', 'tab not persisted');
assert.ok($('pane-teams').classList.contains('on'), 'teams pane not shown');
assert.ok(!$('pane-picks').classList.contains('on'), 'picks pane still shown');
clickSel('[data-tab]', { tab: 'picks' });
assert.ok($('pane-picks').classList.contains('on'), 'could not switch back');
console.log('tabs ....................... ok');

// ---- 8. theme toggle cycles auto -> light -> dark and persists
assert.equal(document.documentElement.getAttribute('data-theme'), null, 'auto must not stamp the root');
assert.equal($('theme').textContent, 'Auto');
fire('theme', 'click');
assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
fire('theme', 'click');
assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
assert.equal(localStorage.getItem('draft-war-room-theme'), 'dark', 'theme choice not persisted');
fire('theme', 'click');
assert.equal(document.documentElement.getAttribute('data-theme'), null, 'cycles back to auto');
console.log('theme toggle ............... ok');

// ---- 9. undo
const n = saved().log.length;
fire('undo', 'click');
assert.equal(saved().log.length, n - 1, 'undo did not pop');
console.log('undo ....................... ok');

// ---- 10. settings re-render without throwing (Teams is gone -- it is locked at 12)
assert.equal(els.has('size'), false, 'the Teams input should no longer exist');
$('rounds').value = '15';
$('lineupStr').value = 'QB1 RB2 WR3 TE1 FLEX1 K1 DEF1';
fire('fmt', 'change');
assert.ok($('scroller').innerHTML.includes('prow'), 'render broke after settings change');
assert.ok($('slots').innerHTML.split('WR').length - 1 >= 3, 'lineup change not reflected');
assert.equal(saved().leagueSize, 12, 'league size must stay 12');
console.log('settings ................... ok');

// ---- 11. bulk import, including a name that cannot resolve
$('bulk').value = "ja'marr chase\nSeattle Defense\nNotARealPlayer";
fire('bulkGo', 'click');
assert.ok($('bulkNote').textContent.includes('Marked 2 of 3'), `bulk: ${$('bulkNote').textContent}`);
assert.ok($('bulkNote').textContent.includes('NotARealPlayer'), 'unresolved name not surfaced');
assert.ok($('bulkNote').textContent.includes('Attributed to slot'), 'bulk must say who it assigned to');
assert.ok(saved().log.every(e => 'team' in e), 'bulk import skipped slot attribution');
console.log('bulk import ................ ok');

// ---- 12. deep draft, alternating the two paths that actually record a pick:
//          a name typed into the box, and a tap on the board. The typed path has
//          a precondition the old commit() lacked (openSheet no-ops on an id that
//          is not in POOL), so it has to be exercised deep, not just at pick 1.
let mine = 0, viaSearch = 0;
for (let i = 0; i < 170; i++) {
  const board = $('cols').innerHTML;
  const idm = /data-pick="(\d+)"/.exec(board);
  if (!idm) break;

  if (i % 3 === 0) {
    const nm = /<span class="nm">([^<]+)<\/span>/.exec(board);
    if (nm) {
      $('q').value = nm[1].replace(/&amp;/g, '&').slice(0, 40);
      fire('q', 'input');
      fire('q', 'keydown', { key: 'Enter' });
      if (!$('sheet').hidden) {
        if (i % 12 === 0) { pickSlot(4); mine++; }
        confirmPick();
        viaSearch++;
        continue;
      }
      $('q').value = ''; fire('q', 'input');   // ambiguous: fall through to tapping
    }
  }

  tapPlayer(idm[1]);
  if (!$('sheet').hidden) {
    if (i % 12 === 0) { pickSlot(4); mine++; }
    confirmPick();
  }
}
assert.ok(viaSearch > 20, `only ${viaSearch} picks went through the search path`);
const deep = saved();
assert.ok(deep.log.length > 100, `deep draft only reached ${deep.log.length} picks`);
assert.ok(mine > 8, `only ${mine} picks were assigned to me`);
assert.ok(deep.log.every(e => e.team === null || (e.team >= 1 && e.team <= 12)),
  'a pick was attributed to a slot outside 1-12');
assert.ok($('scroller').innerHTML.length > 0, 'scroller empty deep in the draft');
assert.ok($('cols').innerHTML.length > 0, 'board empty deep in the draft');
assert.ok($('teams').innerHTML.length > 0, 'team cards empty deep in the draft');
console.log(`deep draft (${deep.log.length} picks, ${viaSearch} typed, ${mine} mine) .... ok`);

// ====================================================================== 2
// ---- 13. MIGRATION: a pre-rework {id, mine} blob must keep its roster.
//          Getting this wrong empties your team and the app looks fine doing it.
await boot({ format: 'ppr', leagueSize: 12, slot: 4, rounds: 16, log: [
  { id: '5672', mine: true },    // Jahmyr Gibbs -- mine
  { id: '5670', mine: false },   // Bijan Robinson -- someone else
]});
assert.equal(saved().log.length, 2, 'legacy log did not survive');
assert.equal(saved().log[0].team, 4, 'my legacy pick lost its slot');
assert.equal(saved().log[1].team, null, "someone else's legacy pick should be slot-unknown");
assert.ok($('rosterNote').textContent.startsWith('1 drafted'),
  `legacy roster lost: ${$('rosterNote').textContent}`);
assert.ok($('teams').innerHTML.includes('Gibbs'), 'legacy pick missing from my team card');
console.log('legacy blob migrates ....... ok');

// ---- 14. MIGRATION: the same, but the blob never stored a slot at all
await boot({ log: [{ id: '5672', mine: true }, { id: '5670', mine: false }] });
chooseMySlot(7);
assert.ok($('rosterNote').textContent.startsWith('1 drafted'),
  `slotless legacy pick fell off the roster: ${$('rosterNote').textContent}`);
assert.ok($('teams').innerHTML.includes('Gibbs'), 'slotless legacy pick vanished from the team cards');
console.log('slotless legacy blob ....... ok');

console.log('\nall smoke checks passed');
