# Firebase production setup

App-এর Firebase config ইতিমধ্যে `js/config.js`-এ বসানো। GitHub Pages link এবং localhost—দুই জায়গাতেই এখন শুধু Firebase production backend চলবে; demo/local data পুরোপুরি বাদ দেওয়া হয়েছে।

## একবারের Console setup

1. Firebase Console → **Authentication → Sign-in method** থেকে **Email/Password** enable করুন।
2. Authentication → **Settings → Authorized domains**-এ app যে host-এ চলবে প্রতিটি domain যোগ করুন—যেমন `sunstarsolutions786.github.io` এবং `vibrant-cashflow.pages.dev`। শুধু domain লিখবেন; `https://`, path বা শেষে `/` দেবেন না।
3. Authentication → **Users** থেকে প্রথম Administrator-এর email/password account তৈরি করুন এবং তার **UID** copy করুন।
4. Firestore Database তৈরি করুন (production mode)। Firestore → Data-তে `users` collection-এর মধ্যে copied UID-কে document ID করে এই fields দিন:

```json
{
  "name": "Administrator",
  "username": "your-email@company.com",
  "role": "admin",
  "active": true,
  "createdAt": "2026-09-06"
}
```

5. Firebase CLI দিয়ে login/project select করে rules ও indexes deploy করুন:

```text
firebase login
firebase use vibrant-cashflow
firebase deploy --only firestore:rules,firestore:indexes,storage
```

শুধু GitHub/Cloudflare-এ `firestore.indexes.json` upload করলে Firebase index তৈরি হয় না; উপরের Firebase CLI deploy একবার চালাতে হবে। `active` field অবশ্যই String `"true"` নয়, Boolean `true` হতে হবে।

6. Hosting-এ শুধু **`dist/` folder** publish হবে — repository root নয়। Root-এর `index.html` শুধু build template; সরাসরি publish করলে app চালু হবে না ("React could not be loaded")। নিচের যেকোনো একটি পদ্ধতি বেছে নিন:

   **GitHub Pages (GitHub Actions দিয়ে):** পুরো project (`node_modules` ছাড়া) repository-তে push/upload করুন। Repository → **Settings → Pages → Build and deployment → Source: GitHub Actions** select করুন। তারপর **Settings → Secrets and variables → Actions → Variables → New repository variable**-এ Name `DEPLOY_TO_GITHUB_PAGES`, Value `true` দিন। এরপর `main` branch-এ প্রতিটি push-এ workflow unit test চালিয়ে `dist/` build করে publish করবে; অবস্থা **Actions** tab-এ দেখা যাবে। পুরোনো "Deploy from a branch → main / root" setting আর ব্যবহার করবেন না।

   **Cloudflare Pages:** Settings → Build → Build command `npm run build`, Build output directory `dist`, এবং Environment variable `NODE_VERSION` = `22`।

   **Firebase Hosting:** `npm run build` চালিয়ে `firebase deploy --only hosting` (firebase.json আগে থেকেই `dist` ব্যবহার করে)।

   Published link খুলে প্রথম admin login করুন, তারপর Master Data import করুন। Production database-এ কোনো demo transaction/master/user seed করা হয় না।

## Production build

Browser `dist/js/app.bundle.min.js` নামে precompiled bundle load করে। React, SheetJS ও ExcelJS `dist/assets/vendor/`-এ থাকে; runtime Babel বা বাইরের JavaScript CDN লাগে না (শুধু Firebase SDK ও Google Fonts বাইরে থেকে আসে)। Source code (`js/`, `styles.css`, `index.html`) বদলালে নতুন করে build করুন:

```text
npm install
npx playwright install chromium
npm run verify
```

`npm run verify` unit test চালায়, `dist/` মুছে নতুন করে তৈরি করে, এবং built `dist/` browser-এ ঠিকমতো চালু হয় কিনা পরীক্ষা করে। `npx playwright install chromium` শুধু প্রথমবার লাগে। `node_modules` GitHub-এ upload করবেন না; `.gitignore` সেটি বাদ দেয়।

`firestore.rules` পরিবর্তন করলে deploy-এর আগে `npm run test:rules` চালান (Java 21 প্রয়োজন)।

## Data layout ও cost control

- প্রতিটি transaction ও budget আলাদা document; একটি row বদলালে পুরো database rewrite হয় না।
- **Report-এর data browser-এ (IndexedDB) রাখা থাকে।** Transaction কখনো delete করা যায় না এবং প্রতিটি save-এ server-এর সময় (`savedAt`) লেখা হয় — তাই report খোলার আগে app Firebase থেকে শুধু "শেষবার দেখার পর যা বদলেছে" সেটুকুই আনে, সাধারণত **1টি read**। একটি device-এ একটি month একবারই পুরো download হয়।
- প্রতি session-এ কোনো month প্রথমবার দেখানোর সময় সেই month-এর record সংখ্যা ও inflow/outflow total Firebase-এর server total-এর সঙ্গে মেলানো হয় (প্রতি 1,000 record-এ প্রায় 1 read)। কোনো পার্থক্য পেলে (যেমন Firebase Console-এ সরাসরি edit) সেই month আবার download হয়। **↻ Refresh** ও Export সবসময় এই যাচাই আবার করে।
- **Budget:** প্রতিটি month-এর lock revision না বদলালে আগের budget row ব্যবহার হয় — Outflow বা Budget page খুললে প্রতিবার 1টি read। Budget save-এর সময়ও পুরো month আবার পড়তে হয় না।
- **Dashboard:** শেষ হিসাব browser-এ রাখা থাকে; তারপর কোনো transaction save না হলে ও bank balance review না বদলালে আবার হিসাব হয় না (1–2 read)। এক মিনিটের মধ্যে ফিরে এলে কোনো read লাগে না।
- **Login/startup:** নিজের profile, Master Data ও Settings live listener থেকেই আসে — একই তিনটি document দুবার পড়া হয় না। Save-এর সময় Master Data আবার পড়া হয় না; category suggestion প্রতি session-এ একবার পড়া হয়।
- Categorize প্রতি page-এ 50 row নেয়, Next/Previous দিয়ে পুরোনো সব row পাওয়া যায়; একবার দেখা page-এ ফিরলে read লাগে না।
- মাপা ফল (6 মাস × প্রতি মাসে 5,000 transaction): প্রথম দিন আগের মতোই (~31,000 read), কিন্তু **পরের দিন 37,330-এর বদলে মাত্র 401 read**।
- `firestore.indexes.json` আবার deploy করতে হবে (`savedAt` index চালু হয়েছে)। Index তৈরি না হওয়া পর্যন্ত বা browser-এ IndexedDB না থাকলে report আগের মতো সরাসরি Firebase থেকে পড়ে — হিসাব ঠিকই থাকে, শুধু সাশ্রয় হয় না।
- **Privacy:** Report data এই browser-এ জমা থাকে। Shared computer-এ ব্যবহারের পর browser settings থেকে site data clear করুন।
- Firebase Storage app ব্যবহার করে না, তাই default rule সব Storage access বন্ধ রাখে।

## Clean cut-over

পুরোনো localStorage test data Firebase-এ upload/migrate হয় না। Production শুরু হবে একেবারে empty transaction, budget, master এবং settings দিয়ে। Browser-এর local test data প্রয়োজন না হলে DevTools → Application → Local Storage থেকে `vcf_`-prefix key-গুলো পরে manually clear করা যাবে।
