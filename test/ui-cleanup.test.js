'use strict';
// UI cleanup V1 (front-end only): the Add asset photo area and the All assets toolbar. Source-level checks, like the other front-end tests.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const src = read('app.js');
const css = read('app.css');

test('Add asset: Photos is a prominent drop area above the label preview, still optional and capped at 10', () => {
  const form = src.slice(src.indexOf('async function viewAssetForm('), src.indexOf('// ============================================================ scan'));
  assert.ok(form.indexOf('photoDropHtml()') > 0 && form.indexOf('photoDropHtml()') < form.indexOf('id="lprev"'), 'Photos above the label preview');
  const area = src.slice(src.indexOf('const photoDropHtml'), src.indexOf('async function viewAssetForm('));
  for (const s of ['id="ph-cam"', 'Take photos', 'Choose files', 'id="ph-pick"', 'accept="image/*" multiple hidden id="ph"', "icon('camera')"]) assert.ok(area.includes(s), s);
  assert.doesNotMatch(area, /\brequired\b/, 'photos are never mandatory');
  assert.match(form, /const room = 10 - pending\.length;/);
  assert.match(form, /openPhotoCapture\(\{ max: 10 - pending\.length, onDone: addPending \}\)/, 'camera capture is unchanged');
  assert.match(form, /drop\.addEventListener\('drop'/, 'drag and drop');
  assert.match(form, /uploadPhotos\(saved\.id, pending\.map\(\(p\) => p\.file\)\)/, 'uploads still go through uploadPhotos');
  assert.match(form, /data-rm="\$\{i\}" aria-label="Remove photo/, 'photos can be removed before saving');
  assert.match(css, /\.ph-drop \{[^}]*dashed/);
});

test('All assets: Add / Labels / Filter menus replace the loose buttons and the status chip strip', () => {
  const page = src.slice(src.indexOf('const ADMIN_STATUSES = ['), src.indexOf('// ============================================================ profile'));
  assert.doesNotMatch(page, /id="chips"|markChips/, 'the horizontal status chips are gone');
  assert.doesNotMatch(page, /desk-only|mob-only/, 'no separate desktop and mobile Add buttons');
  assert.match(page, /ddMenu\(\{ id: 'ddlabels', label: 'Labels'[^\n]*href: '#\/labels\/new', label: 'Create labels'[^\n]*href: '#\/labels', label: 'Print labels'/);
  assert.match(page, /ADMIN_STATUSES\.map\(\(\[v, l\]\) => \(\{ act: 'status', v, label: l \}\)\)/, 'every existing status is a Filter option');
  assert.match(page, /id="fclear" aria-label="Remove the/, 'removable active-filter chip');
  assert.match(page, /window\.matchMedia\('\(max-width: 899px\)'\)\.matches/, 'phones use the bottom sheet');
  assert.match(page, /role="radiogroup"/);
});

test('the status filter survives opening an asset and coming back', () => {
  assert.match(src, /status: st\.status, from: fromSettings\(\)/, 'asset links carry the filter');
  assert.match(src, /srcQ\(c\.src, \{ node: c\.node, id: c\.id, all: c\.all, status: c\.status,/, 'the edit form carries it on');
  assert.match(src, /const x = \[\.\.\.\(c\.status \? \[`status=\$\{c\.status\}`\] : \[\]\)/, 'Back to All assets restores it');
});

test('status filter = direct asset list; unfiltered top level = cards + collapsed All assets (N)', () => {
  const page = src.slice(src.indexOf('const ADMIN_STATUSES = ['), src.indexOf('// ============================================================ profile'));
  assert.match(page, /const filtered = !!st\.status;/);
  assert.match(page, /if \(!filtered && n && ch\.length\) cards\.push\(/, 'cards are hidden while filtered');
  assert.match(page, /const controls = n && !filtered \?/, 'Manage / Add subcategory are hidden while filtered');
  assert.match(page, /paintHead\(\{ cat: !n && !filtered,/, 'Add category is catalog-only');
  assert.match(page, /const filteredTitle = \(\) => \(st\.status === 'maintenance' \? 'Assets in repair' : `\$\{statusLabel\(\)\} assets`\)/);
  assert.match(page, /id="allbtn" aria-expanded="\$\{open\}" aria-controls="allpanel"/, 'accessible disclosure');
  assert.match(page, /listOpen: false/, 'collapsed by default');
  assert.match(page, /\$\('#allpanel'\)\.hidden = !st\.listOpen; return; \} \/\/ no re-render, no reload/, 'toggling does not re-render or refetch');
  const filteredBranch = page.slice(page.indexOf('if (filtered) {'), page.indexOf('} else if (n) {'));
  assert.doesNotMatch(filteredBranch, /allbtn|hidden/, 'a filtered list never starts collapsed');
  assert.match(page, /if \(st\.search\) return renderFound\(\);/, 'search results come first');
  assert.match(page, /const PAGE = 10;/);
  assert.match(css, /\.page-head \{ position: relative; z-index: 6; \}/, 'the header menus stack above the page content');
});

test('every dropdown on the page is wired, including the static Labels menu', () => {
  assert.match(src, /wireDropdowns\(\$\('\.atools'\)\); \/\/ Labels/);
});

test('dropdown behaviour: outside click, Escape, arrow keys, focus styles, accessible names', () => {
  const dd = src.slice(src.indexOf('function ddMenu('), src.indexOf('function confirmSheet('));
  for (const s of ["document.addEventListener('click'", "e.key === 'Escape'", "'ArrowDown'", 'aria-haspopup="menu"', 'aria-expanded="false"', 'role="menu"', 'aria-controls']) assert.ok(dd.includes(s), s);
  assert.match(css, /\.dd-btn:focus-visible/);
  assert.doesNotMatch(src, /import .* from|require\(/, 'no new front-end dependencies');
});

test('the service worker cache and asset versions were bumped', () => {
  assert.doesNotMatch(read('sw.js'), /nc-assets-v5'/);
  assert.doesNotMatch(read('index.html'), /app\.css\?v=1fj\b/, 'css version moved past the pre-slice value');
  assert.doesNotMatch(read('index.html'), /app\.js\?v=1fq\b/, 'js version moved past the pre-slice value');
});

test('appearance: System / Light / Dark through data-theme, stored in localStorage only, set before first paint', () => {
  const html = read('index.html');
  // (a file, not inline, since the Content-Security-Policy allows no inline script)
  assert.ok(html.indexOf('<script src="/theme.js"></script>') > 0 && html.indexOf('/theme.js') < html.indexOf('app.css'), 'the theme is applied before the stylesheet loads (no flash)');
  assert.match(read('theme.js'), /localStorage\.getItem\('nc-theme'\)/);
  assert.match(src, /const THEMES = \[\['system', 'System'\], \['light', 'Light'\], \['dark', 'Dark'\]\];/);
  assert.match(src, /t === 'light' \|\| t === 'dark' \? t : 'system'/, 'System is the default');
  assert.doesNotMatch(src.slice(src.indexOf('const THEME_KEY'), src.indexOf('async function api(')), /fetch|api\(/, 'no API or database involved');
  // CSS: the OS decides unless the person chose Light; an explicit Dark wins over the OS
  assert.match(css, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/);
  assert.match(css, /:root\[data-theme="dark"\] \{/);
  const a = css.match(/:root:not\(\[data-theme="light"\]\) \{([^}]*)\}/)[1].replace(/\s+/g, ' ').trim();
  const b = css.match(/:root\[data-theme="dark"\] \{([^}]*)\}/)[1].replace(/\s+/g, ' ').trim();
  assert.equal(a, b, 'the two copies of the dark palette are identical');
  assert.doesNotMatch(css, /@media \(prefers-color-scheme: dark\) \{ \.(chip|auth)/, 'no dark rule left that ignores an explicit Light choice');
  assert.match(css, /\.label \{ background: #fff; color: #000;/, 'printed labels stay black on white');
});

test('appearance placement: desktop sidebar foot (Settings then Appearance), mobile Profile page, no new bottom tab', () => {
  const nav = src.slice(src.indexOf('const side = ['), src.indexOf('return { tabs: common, side };'));
  assert.match(nav, /key: 'settings', href: '#\/settings', label: 'Settings', icon: 'settings', foot: true/);
  assert.match(src, /<div class="side-foot">\$\{side\.filter\(\(i\) => i\.foot\)\.map\(sideLink\)\.join\(''\)\}<div id="themeslot"><\/div><\/div>/, 'Settings, then Appearance, in the sidebar foot');
  assert.match(src, /side\.filter\(\(i\) => !i\.foot\)/, 'Settings is not repeated in the main list');
  assert.match(src, /ddMenu\(\{ id: 'ddtheme', label: 'Appearance'/);
  const acct = src.slice(src.indexOf('function viewAccount()'), src.indexOf('async function logout()'));
  assert.match(acct, /id="themeseg" role="radiogroup" aria-label="Appearance"/, 'mobile: Appearance on the Profile page');
  assert.match(acct, /\['#\/settings', 'settings', 'Settings'/, 'Profile -> Settings is unchanged');
  const common = src.slice(src.indexOf('const common = ['), src.indexOf('const side = ['));
  assert.doesNotMatch(common, /appearance|theme/i, 'no bottom-nav item added');
  assert.match(css, /@media \(min-width: 900px\) \{\s*\/\* The sidebar is a column/, 'pinned foot is desktop-only');
});
