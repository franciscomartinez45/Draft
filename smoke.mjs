#!/usr/bin/env node
/**
 * Executes the real inlined script from draft.html against a minimal DOM shim.
 * Catches what unit tests cannot: typos, undefined identifiers, and render
 * crashes in the page code itself.
 */
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import assert from 'node:assert/strict';

const html = readFileSync('index.html', 'utf8');
const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
assert.ok(m, 'could not find the module script in index.html');

// ------------------------------------------------------------- DOM shim
const handlers = new Map();          // id -> {event -> fn}
const els = new Map();
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
const docHandlers = {};
const rootAttrs = new Map();
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
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
};
globalThis.confirm = () => true;

// ------------------------------------------------------------- run it
const tmp = './.smoke-app.mjs';
writeFileSync(tmp, m[1]);
try {
  await import('./.smoke-app.mjs');
} finally {
  unlinkSync(tmp);
}

const KEY = 'draft-war-room-2026';
const $ = (id) => document.getElementById(id);
const fire = (id, ev, e = {}) => handlers.get(id)?.[ev]?.({ preventDefault() {}, ...e });

// ---- 1. it booted and rendered
assert.ok($('call').innerHTML.includes('BEST PICK'), 'recommendations did not render');
assert.ok($('cols').innerHTML.includes('Tier 1'), 'board did not render tiers');
assert.ok($('slots').innerHTML.includes('QB'), 'roster slots did not render');
assert.ok(/pick 1/i.test($('clockTxt').textContent), `clock did not render: ${$('clockTxt').textContent}`);
assert.ok($('clock').classList.contains('live'), 'slot 1 at pick 1 means you are on the clock');
assert.ok($('fmt').innerHTML.includes('PPR'), 'format selector not populated');
console.log('boot render ................. ok');

// ---- 2. unique name + Enter commits
$('q').value = 'gibbs';
fire('q', 'input');
assert.ok($('res').innerHTML.includes('Jahmyr Gibbs'), 'suggestion list missing Gibbs');
fire('q', 'keydown', { key: 'Enter', shiftKey: false });
let saved = JSON.parse(localStorage.getItem(KEY));
assert.equal(saved.log.length, 1, 'Enter did not record the pick');
assert.equal(saved.log[0].mine, false, 'plain Enter must mean SOMEONE ELSE took him');
assert.ok(!$('cols').innerHTML.includes('Jahmyr Gibbs'), 'drafted player still on the board');
console.log('enter marks drafted ......... ok');

// ---- 3. Shift+Enter fills MY roster
$('q').value = 'bijan';
fire('q', 'input');
fire('q', 'keydown', { key: 'Enter', shiftKey: true });
saved = JSON.parse(localStorage.getItem(KEY));
assert.equal(saved.log.length, 2);
assert.equal(saved.log[1].mine, true, 'Shift+Enter must mean I drafted him');
assert.ok($('rosterNote').textContent.startsWith('1 drafted'), 'roster did not count my pick');
console.log('shift+enter fills roster .... ok');

// ---- 4. THE SAFETY PROPERTY: ambiguous input must never auto-commit
$('q').value = 'brown';
fire('q', 'input');
assert.ok($('res').innerHTML.includes('pick the right one'), 'no disambiguation prompt shown');
const before = JSON.parse(localStorage.getItem(KEY)).log.length;
fire('q', 'keydown', { key: 'Enter', shiftKey: false });
const after = JSON.parse(localStorage.getItem(KEY)).log.length;
assert.equal(after, before, 'AMBIGUOUS INPUT WAS AUTO-COMMITTED — the worst possible bug');
// ...but an explicit digit choice does commit
fire('q', 'keydown', { key: '2', shiftKey: false });
assert.equal(JSON.parse(localStorage.getItem(KEY)).log.length, before + 1,
  'digit key did not select from the list');
console.log('ambiguity requires confirm .. ok');

// ---- 4b. theme toggle cycles auto -> light -> dark and persists
assert.equal(document.documentElement.getAttribute('data-theme'), null, 'auto must not stamp the root');
assert.equal($('theme').textContent, 'Auto');
fire('theme', 'click');
assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
fire('theme', 'click');
assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');
assert.equal(localStorage.getItem('draft-war-room-theme'), 'dark', 'theme choice not persisted');
fire('theme', 'click');
assert.equal(document.documentElement.getAttribute('data-theme'), null, 'cycles back to auto');
console.log('theme toggle ................ ok');

// ---- 5. undo
const n = JSON.parse(localStorage.getItem(KEY)).log.length;
fire('undo', 'click');
assert.equal(JSON.parse(localStorage.getItem(KEY)).log.length, n - 1, 'undo did not pop');
console.log('undo ........................ ok');

// ---- 6. state survives a reload
const snapshot = localStorage.getItem(KEY);
assert.ok(JSON.parse(snapshot).log.length > 0, 'nothing persisted');
console.log('persistence ................. ok');

// ---- 7. settings changes re-render without throwing
$('size').value = '14'; $('slot').value = '9'; $('rounds').value = '15';
$('lineupStr').value = 'QB1 RB2 WR3 TE1 FLEX1 K1 DEF1';
fire('fmt', 'change');
assert.ok($('call').innerHTML.includes('BEST PICK'), 'render broke after settings change');
assert.ok($('slots').innerHTML.split('WR').length - 1 >= 3, 'lineup change not reflected');
console.log('settings .................... ok');

// ---- 8. bulk import, including a name that cannot resolve
$('bulk').value = "ja'marr chase\nSeattle Defense\nNotARealPlayer";
fire('bulkGo', 'click');
assert.ok($('bulkNote').textContent.includes('Marked 2 of 3'), `bulk: ${$('bulkNote').textContent}`);
assert.ok($('bulkNote').textContent.includes('NotARealPlayer'), 'unresolved name not surfaced');
console.log('bulk import ................. ok');

// ---- 9. deep draft: alternate the search path and the click path
$('bulk').value = '';
$('q').value = '';
fire('q', 'input');
let viaSearch = 0;
for (let i = 0; i < 160; i++) {
  const board = $('cols').innerHTML;
  const idm = /data-gone="(\d+)"/.exec(board);
  if (!idm) break;

  if (i % 3 === 0) {
    // real name typed into the box, exactly as it happens at the table
    const nm = /<span class="nm">([^<]+)<\/span>/.exec(board);
    if (nm) {
      $('q').value = nm[1].replace(/&amp;/g, '&').slice(0, 40);
      fire('q', 'input');
      const before = JSON.parse(localStorage.getItem(KEY)).log.length;
      fire('q', 'keydown', { key: 'Enter', shiftKey: i % 12 === 0 });
      if (JSON.parse(localStorage.getItem(KEY)).log.length > before) { viaSearch++; continue; }
      $('q').value = ''; fire('q', 'input');   // ambiguous: fall through to clicking
    }
  }
  docHandlers.click?.({
    preventDefault() {},
    shiftKey: i % 12 === 0,
    target: { closest: (s) => (s === '[data-take]' ? null : { dataset: { gone: idm[1] } }) },
  });
}
const deep = JSON.parse(localStorage.getItem(KEY));
assert.ok(deep.log.length > 100, `deep draft only reached ${deep.log.length} picks`);
assert.ok(viaSearch > 20, `only ${viaSearch} picks went through the search path`);
assert.ok($('call').innerHTML.length > 0, 'call section empty deep in the draft');
assert.ok($('cols').innerHTML.length > 0, 'board empty deep in the draft');
console.log(`deep draft (${deep.log.length} picks, ${viaSearch} typed) ... ok`);

console.log('\nall smoke checks passed');
