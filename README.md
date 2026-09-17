# VIBRANT CashFlow

Group cash-flow management for multiple businesses (Verticals). Bank statements and cash entries are imported or entered, categorized into Vertical → Head → Sub-head, compared against monthly budgets, and exported as formatted Excel and HTML reports.

The app is a static single-page application backed by Firebase Authentication and Cloud Firestore. There is no custom server.

A Bengali step-by-step guide for the one-time Firebase setup is in [`FIREBASE_SETUP_BN.md`](FIREBASE_SETUP_BN.md).

## Roles

| Role | Access |
| --- | --- |
| Administrator | Everything, including Budget & Booking, Master Data, User Management and settings. Not limited by the edit lock. |
| Back Office | Dashboard, statement and cash entry, categorization, analysis and exports. Can only change transactions dated within the edit-lock window (default 7 days). |
| Viewer | Dashboard, analysis and exports (read only). |

The same permissions are enforced on the server by `firestore.rules`, so the browser UI is not the only safeguard.

## Project layout

```text
index.html, styles.css, js/   Application source (React via JSX, no framework build chain)
assets/                       Logo
build.mjs                     Builds the deployable site into dist/
dist/                         Deployable static site (generated; publish this folder only)
firestore.rules               Server-side security rules
firestore.indexes.json        Required Firestore indexes
storage.rules                 Denies all Cloud Storage access (the app does not use Storage)
firebase.json                 Firebase Hosting / rules / emulator configuration
tests/                        Unit, export, browser, deployed-build and security-rules tests
.github/workflows/            CI build and optional GitHub Pages deployment
```

The root `index.html` is a template. Opening or publishing it directly does not work, because vendor libraries and the compiled bundle exist only in `dist/`.

## One-time Firebase setup

1. In Firebase Console, enable **Authentication → Sign-in method → Email/Password**.
2. Add every hosting domain under **Authentication → Settings → Authorized domains** (domain only, no `https://` or path).
3. Create the first administrator in **Authentication → Users** and copy their UID.
4. Create the Firestore database in production mode. In the `users` collection, create a document whose ID is that UID with the fields `name` (string), `username` (the login email), `role` = `"admin"`, `active` = `true` (Boolean, not the string `"true"`), and `createdAt` (e.g. `"2026-09-16"`).
5. Deploy rules and indexes (indexes are not created by uploading the JSON file anywhere else):

   ```text
   npm install
   npx firebase login
   npx firebase use vibrant-cashflow
   npx firebase deploy --only firestore:rules,firestore:indexes,storage
   ```

   Deploy indexes again whenever `firestore.indexes.json` changes. This version enables the `savedAt` index that the change feed uses; until it is built, reports still work but read Firebase directly.

The web configuration in `js/config.js` points at the `vibrant-cashflow` project. Firebase web API keys are public identifiers; access is controlled by Authentication and the security rules.

## Deploying

Publish **only the `dist/` folder**. Choose one host.

**GitHub Pages.** Push the project (without `node_modules`) to the `main` branch. In the repository, set **Settings → Pages → Build and deployment → Source** to **GitHub Actions**, then add the repository variable **Settings → Secrets and variables → Actions → Variables → `DEPLOY_TO_GITHUB_PAGES` = `true`**. Every push to `main` then runs the unit tests, builds `dist/` and publishes it. Without the variable the workflow still tests and builds but does not publish, so it stays green when you host elsewhere. Do not use the old "Deploy from a branch → main / root" option.

**Cloudflare Pages.** Build command `npm run build`, build output directory `dist`, environment variable `NODE_VERSION` = `22`. The generated `dist/_headers` file sets caching and basic security headers.

**Firebase Hosting.** Run `npm run build`, then `npx firebase deploy --only hosting`. `firebase.json` already serves `dist/`.

After the first deployment, sign in as the administrator and import Master Data (Bank Accounts, Verticals, Heads & Sub-heads) from **Master Data → Download Template → Import**.

## Development

Requires Node.js 20 or newer.

```text
npm install
npx playwright install chromium      # once, for the browser tests
npm run verify                        # unit tests + fresh build + built-site smoke test
```

| Command | What it does |
| --- | --- |
| `npm run build` | Deletes and rebuilds `dist/` (minified bundle, vendor libraries, cache-busted `index.html`). |
| `npm test` | Unit tests: import de-duplication and retry, budgets, concurrency, pagination, change-feed sync and verification, billed-read counts, dates and amounts, and Excel export correctness/performance. |
| `npm run test:ui` | Full browser scenario against an in-memory Firestore: categorization, corrections, imports, budgets, Excel download, IndexedDB report sync and Refresh, mobile layout, role changes. |
| `npm run test:dist` | Serves the built `dist/` like a static host and checks it boots, with all assets present, and shows a Retry screen when Firebase is unreachable. |
| `npm run test:rules` | Security-rules tests in the Firestore emulator (requires Java 21). Run before deploying any change to `firestore.rules`. |

Set `VCF_CHROMIUM` to a browser executable if Playwright's Chromium is installed somewhere unusual.

## Data model and cost controls

Firestore bills one read per document a query returns (minimum one per query) and one read per 1,000 entries scanned by `count`/`sum`. The app is built so repeat use costs almost nothing.

**Reports read a local copy, updated from a change feed.** Transactions can never be deleted (enforced by the rules) and every save stamps `savedAt` with the server's commit time, so "records saved after my last check" is a complete list of changes. Inflow, Outflow and Export keep transactions in the browser's IndexedDB (`js/localStore.js`). Before each report the app asks Firebase only for records saved since its last check, which is usually a single read. A month is copied from Firebase once per device. The first time a month is shown in each session, its record count and inflow/outflow totals are compared with Firebase's server-side totals (about one read per 1,000 records); if anything differs, for example a record edited directly in the Firebase console, that month is copied again. Refresh and exports repeat that check. After a long absence with more than 20,000 changes, the copy is rebuilt for the months in use instead of replaying the backlog.

**Budgets** are reused while each month's lock revision is unchanged (every budget write increments it, enforced by the rules), so opening Outflow or the Budget page costs one read per visit instead of every budget row. Budget saves also skip re-reading the month when its revision proves the loaded rows are current.

**Dashboard** results are stored locally and reused while no transaction has been saved since they were computed and bank balance reviews are unchanged (one or two reads). Returning within a minute costs nothing; any save from this browser forces a fresh check.

**Startup** takes the signed-in user's profile, Master Data and Settings from their live listeners instead of reading the same three documents twice. These are the only real-time listeners; saves never re-read Master Data, and category suggestion memory is read once per session. Categorize reads 50 rows per page and keeps pages already visited.

Measured with the in-memory test double (6 months × 5,000 transactions, 200 budget lines a month; each day: dashboard twice, six-month trend, Inflow and Outflow for two months, Budget page, Excel export):

| | Previous version | This version |
| --- | --- | --- |
| Day 1 (first use on the device) | 36,926 reads | 31,334 reads |
| Day 2, after 200 imports and 100 edits | 37,330 reads | 401 reads |

If IndexedDB is unavailable (some private-browsing modes) or the `savedAt` index has not been deployed, reports read Firebase directly for that session, exactly as before: figures stay correct, only the saving is lost. The Firebase SDK itself uses a memory cache, so large reads are not written to browser storage twice.

**Privacy note.** Report data is stored in this browser's IndexedDB so it does not have to be downloaded again. On a shared computer, clear the site's data in the browser settings after use.

## Release notes

### Latest
- **Firebase reads cut by ~99% for everyday use.** Reports use a local copy kept current by a change feed, with a once-per-session server totals check; budgets and the dashboard are revalidated cheaply instead of re-read; startup no longer reads three documents twice; budget saves no longer re-read the month; the SDK uses a memory cache. Requires deploying `firestore.indexes.json` (enables the `savedAt` index). Security rules are unchanged.
- **Tests.** 33 unit tests (including exact billed-read counts) and 11 browser scenarios using real IndexedDB.

### Earlier
- **Fewer Firebase reads.** Report cache with Refresh on Dashboard, Inflow and Outflow; saves no longer re-read Master Data; Categorize reuses visited pages; suggestion memory is read once per session.
- **Dead code removed.** Found with ESLint plus a method and CSS usage scan (verified against deliberately planted dead code): unused query options, a never-shown import badge, uncounted blank-row tallies, duplicate `ok` flags, an impossible check, an unused component prop, an unused CSS rule and legacy input branches.

### Previous

- **Deployment fixed.** The previously documented root deployment could not start (React was only present in `dist/`). `dist/` is now the single deployable output, rebuilt from scratch on each build; the stale root bundle was removed; deployment guides, a CI workflow and Cloudflare headers were added.
- **Stale build replaced.** The shipped bundle predated the last Cash Entry change (changing the cash business now clears a category from a different business). `dist/` is rebuilt from current source.
- **Excel export speed.** The OUTFLOW sheet no longer rescans every transaction for each cell: 20,000 rows went from about 54 s to 0.3 s, and 100,000 rows take under 1 s, with cell-for-cell identical output. The Raw Data sheet uses bulk row writes.
- **Fixes.** Broken apostrophe on the Statement upload page; Booking inputs are locked while saving or importing; HTML report errors show the real cause; cash imports record the same audit fields as statement imports (`importGroupKey`, `importOccurrence`, `importHashVersion`).
- **Tests.** New export regression test and built-site smoke test; the browser test now finds Chromium on Windows, macOS and Linux.
