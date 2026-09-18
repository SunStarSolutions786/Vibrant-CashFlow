# VIBRANT CashFlow — Setup ও Deploy গাইড

App-এর Firebase config ইতিমধ্যে `js/config.js`-এ বসানো আছে। Website চলে **Cloudflare Pages**-এ (`vibrant-cashflow.pages.dev`), data থাকে **Firebase**-এ।

## Project-এ কী আছে

| File / Folder | কাজ |
| --- | --- |
| `dist/` | **Live website** — Cloudflare শুধু এই folder publish করে। হাতে edit করবেন না। |
| `js/`, `index.html`, `styles.css`, `assets/` | Source code — কোনো পরিবর্তন এখানে করে `dist/` নতুন করে build করতে হয়। |
| `build.mjs`, `package.json`, `package-lock.json` | `dist/` build করার ব্যবস্থা। |
| `firestore.rules`, `firestore.indexes.json`, `storage.rules`, `firebase.json` | Firebase security rules ও index — Firebase CLI দিয়ে deploy হয়। |

## ১. Firebase Console setup (একবারই)

1. **Authentication → Sign-in method** থেকে **Email/Password** enable করুন।
2. **Authentication → Settings → Authorized domains**-এ `vibrant-cashflow.pages.dev` (এবং নিজের custom domain থাকলে সেটিও) যোগ করুন। শুধু domain লিখবেন — `https://` বা `/` দেবেন না।
3. **Authentication → Users** থেকে প্রথম Administrator-এর account তৈরি করে তার **UID** copy করুন।
4. **Firestore Database** তৈরি করুন (production mode)। `users` collection-এ copied UID-কে document ID করে এই fields দিন:

```json
{
  "name": "Administrator",
  "username": "your-email@company.com",
  "role": "admin",
  "active": true,
  "createdAt": "2026-09-17"
}
```

`active` অবশ্যই Boolean `true` হবে, String `"true"` নয়।

## ২. Firebase rules ও indexes deploy

Computer-এ **Node.js** install থাকলে project folder-এ terminal খুলে চালান:

```text
npx firebase-tools login
npx firebase-tools use vibrant-cashflow
npx firebase-tools deploy --only firestore:rules,firestore:indexes,storage
```

- `firestore.rules` বা `firestore.indexes.json` বদলালে প্রতিবার শেষ command-টি আবার চালাতে হবে। GitHub-এ upload করলে Firebase-এ নিজে থেকে deploy হয় না।
- Index তৈরি হতে কয়েক মিনিট লাগে। তার আগে app ঠিকই চলে, শুধু Firebase read সাশ্রয় (নিচে দেখুন) চালু হয় না।

## ৩. Cloudflare Pages settings

**Workers & Pages → vibrant-cashflow → Settings → Build**:

| Setting | Value |
| --- | --- |
| Git repository | `SunStarSolutions786/Vibrant-CashFlow` |
| Production branch | `main` |
| Build command | `exit 0` |
| Build output | `dist` |
| Root directory | (খালি) |

GitHub-এর `main` branch-এ upload করলেই Cloudflare নিজে থেকে নতুন version publish করে। Build output অবশ্যই `dist` থাকবে — না হলে "could not start" error দেখাবে।

প্রথমবার link খুলে Administrator login করুন, তারপর **Master Data → Template → Import** করে Bank Accounts, Verticals, Heads ও Sub-heads যোগ করুন।

## ৪. Code পরিবর্তনের পর নতুন build

`dist/` ইতিমধ্যে build করা আছে। শুধু `js/`, `index.html` বা `styles.css` বদলালে project folder-এ চালান:

```text
npm install
npm run build
```

তারপর পুরো project (নতুন `dist/` সহ, `node_modules` ছাড়া) GitHub-এ upload করুন। `npm run build` প্রতিবার পুরোনো `dist/` মুছে নতুন তৈরি করে।

## Firebase খরচ কমানোর ব্যবস্থা

- প্রতিটি transaction ও budget আলাদা document; একটি row বদলালে পুরো database rewrite হয় না।
- **Report-এর data browser-এ (IndexedDB) রাখা থাকে।** Transaction delete করা যায় না এবং প্রতিটি save-এ server-এর সময় (`savedAt`) লেখা হয়, তাই report খোলার আগে app শুধু "শেষবার দেখার পর যা বদলেছে" সেটুকু আনে — সাধারণত **1টি read**। একটি device-এ একটি month একবারই পুরো download হয়।
- প্রতি session-এ কোনো month প্রথমবার দেখানোর সময় record সংখ্যা ও inflow/outflow total Firebase-এর server total-এর সঙ্গে মেলানো হয় (প্রতি 1,000 record-এ প্রায় 1 read)। পার্থক্য পেলে (যেমন Firebase Console-এ সরাসরি edit) সেই month আবার download হয়। **↻ Refresh** ও Export সবসময় এই যাচাই করে।
- **Budget:** month-এর lock revision না বদলালে আগের row ব্যবহার হয় — Outflow বা Budget page খুললে 1টি read। Save-এর সময়ও পুরো month আবার পড়া হয় না।
- **Dashboard:** কোনো transaction save না হলে ও bank balance review না বদলালে আগের হিসাব ব্যবহার হয় (1–2 read); এক মিনিটের মধ্যে ফিরে এলে কোনো read লাগে না।
- **Login:** profile, Master Data ও Settings live listener থেকে আসে — একই document দুবার পড়া হয় না। Categorize প্রতি page-এ 50 row নেয়; দেখা page-এ ফিরলে read লাগে না।
- মাপা ফল (6 মাস × মাসে 5,000 transaction): প্রথম দিন ~31,000 read, **পরের দিন মাত্র 401 read** (আগে 37,330)।
- Browser-এ IndexedDB না থাকলে (কিছু private mode) report সরাসরি Firebase থেকে পড়ে — হিসাব ঠিক থাকে, শুধু সাশ্রয় হয় না।
- **Privacy:** Report data এই browser-এ জমা থাকে। Shared computer-এ ব্যবহারের পর browser settings থেকে site data clear করুন।
