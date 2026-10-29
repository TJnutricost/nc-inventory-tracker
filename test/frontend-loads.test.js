// The front end must at least EXECUTE: a top-level error in public/app.js (e.g. ROUTES naming a `const` view declared further down: a
// temporal-dead-zone ReferenceError) leaves the browser on the splash screen forever, and `node --check` cannot see it. This runs the script's
// top level in a vm with a permissive fake browser; nothing is rendered.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const deep = () => new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => '' : k === 'length' ? 0 : deep()), apply: () => deep(), construct: () => deep(), set: () => true });

test('front end: public/app.js runs its top level without throwing', () => {
  const win = { addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }), location: { hash: '', href: 'http://localhost/', search: '' }, history: { replaceState() {}, pushState() {} }, scrollTo() {}, navigator: {}, localStorage: { getItem: () => null, setItem() {} }, sessionStorage: { getItem: () => null, setItem() {} } };
  const ctx = { window: win, document: deep(), navigator: {}, location: win.location, history: win.history, localStorage: win.localStorage, sessionStorage: win.sessionStorage,
    fetch: () => new Promise(() => {}), setTimeout: () => 0, setInterval: () => 0, clearTimeout() {}, console, URLSearchParams, Intl, Date, requestAnimationFrame: () => 0, matchMedia: win.matchMedia, addEventListener() {}, getComputedStyle: () => ({}), CSS: { supports: () => true } };
  vm.createContext(ctx);
  assert.doesNotThrow(() => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8'), ctx, { filename: 'app.js' }));
});
