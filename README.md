# VIBRANT CashFlow

Group cash-flow management for multiple businesses (Verticals). Bank statements and cash entries are imported or entered, categorized into Vertical → Head → Sub-head, compared against monthly budgets, and exported as formatted Excel and HTML reports.

The app is a static single-page application hosted on **Cloudflare Pages**, backed by Firebase Authentication and Cloud Firestore. There is no custom server. A step-by-step Bengali guide is in [`FIREBASE_SETUP_BN.md`](FIREBASE_SETUP_BN.md).

## Roles

| Role | Access |
| --- | --- |
| Administrator | Everything, including Budget & Booking, Master Data, User Management and settings. Not limited by the edit lock. |
| Back Office | Dashboard, statement and cash entry, categorization, analysis and exports. Can only change transactions dated within the edit-lock window (default 7 days). |
| Viewer | Dashboard, analysis and exports (read only). |

The same permissions are enforced on the server by `firestore.rules`.

## Project layout

| Path | Purpose |
| --- | --- |
| `dist/` | The live website. Cloudflare Pages publishes only this folder. Generated; do not edit by hand. |
| `index.html`, `styles.css`, `js/`, `assets/` | Application source. Change these, then rebuild `dist/`. |
| `build.mjs`, `package.json`, `package-lock.json` | Build tooling for `dist/`. |
| `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `firebase.json` | Firebase security rules and indexes, deployed with the Firebase CLI. |

## Firebase setup (once)

1. Enable **Authentication → Sign-in method → Email/Password**.
2. Add `vibrant-cashflow.pages.dev` (and any custom domain) under **Authentication → Settings → Authorized domains**.
3. Create the first administrator in **Authentication → Users** and copy the UID.
4. Create the Firestore database in production mode. In `users`, add a document whose ID is that UID with `name`, `username` (login email), `role` = `"admin"`, `active` = `true` (Boolean) and `createdAt`.
5. Deploy rules and indexes (requires Node.js; repeat whenever these files change):

   ```text
   npx firebase-tools login
   npx firebase-tools use vibrant-cashflow
   npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
   ```

## Cloudflare Pages

Settings → Build: repository `SunStarSolutions786/Vibrant-CashFlow`, production branch `main`, build command `exit 0`, build output `dist`, root directory empty. Every upload to `main` publishes automatically. After the first deployment, sign in as the administrator and import Master Data from **Master Data → Download Template → Import**.

## Changing the code

`dist/` is already built. After editing the source, run:

```text
npm install
npm run build
```

`npm run build` deletes and recreates `dist/` (minified bundle, vendor libraries, cache-busted `index.html`, Cloudflare `_headers`). Upload the project including the new `dist/`, without `node_modules`.

## Firebase cost controls

Firestore bills one read per document returned (minimum one per query) and one read per 1,000 entries for `count`/`sum` aggregations.

- **Reports read a local copy updated from a change feed.** Transactions cannot be deleted and every save stamps `savedAt` with the server commit time, so the app keeps transactions in the browser's IndexedDB and asks Firebase only for records saved since its last check (usually one read). A month is copied once per device. The first time a month is shown in each session, its count and totals are compared with Firebase's server-side totals; any difference re-copies that month. Refresh and exports repeat the check.
- **Budgets** are reused while the month's lock revision is unchanged (one read per visit), and saves skip re-reading the month.
- **Dashboard** results are reused while nothing has been saved and balance reviews are unchanged.
- **Startup** takes the user profile, Master Data and Settings from live listeners instead of reading them twice. Categorize loads 50 rows per page and keeps visited pages.

Measured over two days of typical use with 6 months × 5,000 transactions: day 1 about 31,000 reads, day 2 **401 reads** (previously 37,330). If IndexedDB is unavailable or the `savedAt` index has not been deployed, reports read Firebase directly: figures stay correct, only the saving is lost.

**Privacy:** report data is stored in the browser. On shared computers, clear the site's data after use.
