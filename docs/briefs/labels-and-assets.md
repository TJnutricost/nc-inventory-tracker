## Slice brief: asset labels at intake, blank labels, and one "All assets" page

Status: APPROVED 2026-10-27 (owner); built 2026-10-27, awaiting review (see "As built").
Base: `feature/google-sign-in` head (= `stage` content). Branch `feature/labels-and-assets`. No schema change. No Railway.

### Why
Today a label can only be printed after an asset is saved (Print labels picks saved assets). The owner wants labels at intake, two ways:
1. **Add asset makes the label.** Opening the form shows the asset's tag and its label at once; it can be printed right there.
2. **Blank labels first.** Print a batch of numbered labels, stick one on each device, then scan the label: the Add asset form opens with
   that tag filled in.
And one place for assets: "All assets" becomes the catalog-style page; the separate "Equipment catalog" and "Print labels" menu items go,
"Print labels" and "Create labels" become sub-items of "All assets".

### Owner answers (2026-10-27)
- Q1 tag at form open: shown as soon as the form opens; a form that is cancelled must not burn the number (the next form shows it again).
  Design that meets both: the form shows the next number (a preview, as today's placeholder, now with its barcode label); the number is
  **claimed only by "Print label" or by Save**. Not printed + cancelled: nothing consumed. Printed + cancelled: that label is out in the
  world, so it is treated like a blank label (scanning it opens Add asset with it). Two admins opening the form at once see the same
  preview; whoever prints or saves first gets it and the other form is told the new number before printing.
- Q2 blank labels: enter a count (default 30 = one Avery 5160 sheet, max 300), the next numbers are claimed at once and printed. The label
  shows the company line, the barcode and the tag; the name line is left empty.
- Q3 one page: the catalog drill-down, plus the search box and the status chips of today's All assets (All / Available / Checked out /
  Overdue / In repair / Lost / Retired / Disposed), so the Home stat cards (`#/assets?status=overdue`, ...) keep working. Catalog structure
  management (Manage, archived entries) moves into it; Settings' "Manage the equipment catalog" points to it.
- Q4 an unknown code (no asset, not one of our claimed labels), admin only: "Add a new asset" with the code as its **serial number**
  (a manufacturer barcode is usually the serial); the existing "use it as the tag" stays as a second choice. Employees: "not found", as now.

### Design
- **Claiming numbers** (no schema change): the existing durable counter `asset_tag_counter` already issues tags and is never lowered.
  New `assetRecords.claimTags({ prefix, count })` (SQLite and PostgreSQL twin, ONE transaction, the counter row locked on PostgreSQL as
  `allocateTag` does) advances it by `count`, skipping numbers already used by a manually chosen tag, and returns the tags. A claimed number
  is never issued again, so a printed label can never be given to a second asset.
- **Is a scanned code one of our labels?** New `assetRecords.issuedTag(tag)`: true when the tag is `<current tag_prefix><number>` with the
  number at or below the counter and no asset uses it. Limitation: labels printed under an earlier prefix are not recognised after the
  prefix changes (they still open "Add a new asset" through the unknown-code choice).
- **Routes (admin):** `POST /api/tags/claim { count }` -> `{ tags }`; `GET /api/assets/lookup/:code` also answers `issued: true` for an
  admin when the code is a claimed, unused tag. `POST /api/assets` is unchanged (it already accepts a chosen tag).
- **Add asset form:** a label card under the tag field: the barcode of the tag field (or of the preview when blank) and "Print label".
  Print with an empty tag field: claim 1, put it in the field, print one label. Print with a typed / scanned tag: print it as is (no claim).
  `#/new?tag=X` (from a scan) and `#/new?serial=X` prefill the fields.
- **Create labels** (`#/labels/new`): the count, "Create & print"; the claimed range is shown ("NC-00056 – NC-00085") so a sheet can be
  reprinted from Print labels' new "Unused labels" option if the printer jams.
- **Scan:** a claimed unused tag opens `#/new?tag=X` directly; an unknown code offers serial (primary) or tag.
- **Navigation:** sidebar and mobile menu: "All assets" with the sub-items "Print labels" (`#/labels`) and "Create labels"
  (`#/labels/new`); "Equipment catalog" and the top-level "Print labels" removed; `#/catalog...` links redirect to `#/assets...` with the
  same node. On a phone the two label pages are also buttons at the top of All assets. Employees' Browse is unchanged.

### Files
`src/assetRecords.js`, `src/pg/assetRecords.js`, `src/dataSeam/sqlite.js` (claimTags, issuedTag); `src/server.js` (the claim route, the
lookup flag); `public/app.js` / `public/app.css` (form label card, Create labels, merged All assets, nav, scan); tests; README, PROJECT_STATUS.

### Tests
Claiming: N numbers, consecutive, skipping manually used tags, never re-issued, concurrent claims never overlap (PostgreSQL overlap test),
same result on both engines (differential). Lookup: an admin gets `issued` for a claimed unused tag, not for a used one, an unclaimed
number, another prefix or an employee. Create with a claimed tag; the form preview does not consume a number. Front-end source checks for
the nav and the routes. Full suite on both drivers.

### As built (2026-10-27)
- Data: `assetRecords.claimTags` / `issuedTag` (+ the pure `issuedNumber`) on both drivers, bound in the seam; `POST /api/tags/claim`
  (1..300, admin); `GET /api/assets/lookup/:code` adds `issued: <tag>` for IT. No schema change.
- Reprinting a blank sheet: instead of a Print labels "unused labels" option, Create labels keeps the reserved sheet on screen with
  **Print again** until the page is left (covers a jammed printer; a later reprint of an unused label is not offered yet).
- Front end: `viewAdminAssets` (the former `viewCatalog`, with the asset search folded into its one search box, the status chips, the
  top-level list with CSV export, Add asset / Add category / calendar in the header, label buttons, scan, FAB); `viewAssets` routes IT
  there; `#/catalog...` redirects to `#/assets...`; shared `labelHtml` / `drawBarcodes` / `printLabels`; `viewCreateLabels`; the form's
  label card; `handleScannedCode` (issued -> Add asset; unknown -> serial first, tag second); sidebar sub-items (`.sidebar a.sub`) and the
  admin drawer entries.
- Tests: `test/labels.test.js` (both drivers: preview consumes nothing, claims skip and are skipped, issued lookup, admin-only, 1..300,
  front-end wiring); claim / issued differential and a parallel claims-vs-creates race in `test/pg/pg-asset-records.test.js`; the
  source-pinning tests of the catalog / menu / calendar entry points updated to the merged page.
- Checked in headless Chrome (desktop 1280 and phone 390): All assets root, a category, a status filter, Add asset with its label,
  Create labels.
- Follow-ups (owner, 2026-10-27): more space between the category cards and the top-level list; All assets' sub-items (Print labels,
  Create labels) show in the sidebar only while you are in All assets or a label page (`.sidebar.assets-open`); Settings moved next to
  My profile (sidebar bottom, avatar menu, the phone's Profile tab) and out of the admin section / hamburger.
- Follow-ups (owner, 2026-10-27): every asset list on All assets (top level, a category, search results) shows 10 per page with a pager
  (page resets on a new entry, status or search); a category with entries below it lists its whole branch right under its cards (the
  "All in" card is the marked default, a subcategory card narrows it; this closes the PROJECT_STATUS UX correction).
