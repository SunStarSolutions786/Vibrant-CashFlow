# Firebase production setup

App-এর Firebase config ইতিমধ্যে `js/config.js`-এ বসানো। GitHub Pages link এবং localhost—দুই জায়গাতেই এখন শুধু Firebase production backend চলবে; demo/local data পুরোপুরি বাদ দেওয়া হয়েছে।

## একবারের Console setup

1. Firebase Console → **Authentication → Sign-in method** থেকে **Email/Password** enable করুন।
2. Authentication → **Settings → Authorized domains**-এ আপনার GitHub Pages domain (যেমন `yourname.github.io`) যোগ করুন।
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

6. এই folder-এর সব file/folder repository root-এ upload করুন। GitHub repository → **Settings → Pages → Deploy from a branch → main / root** select করুন। Published link খুলে প্রথম admin login করুন, তারপর Master Data import করুন। Production database-এ কোনো demo transaction/master/user seed করা হয় না।

## Data layout ও cost control

- প্রতিটি transaction ও budget আলাদা document; একটি row বদলালে পুরো database rewrite হয় না।
- Dashboard total `sum/count` aggregation দিয়ে আসে; সব transaction download হয় না।
- Categorize সর্বোচ্চ 250 recent row নেয়। Analysis শুধু selected month/ছয় মাসের range নেয়।
- Export page খোলার সময় finance data পড়ে না; Generate চাপলে selected range 500-row page করে নেয় (সর্বোচ্চ 100,000 rows)।
- কোনো realtime listener নেই। IndexedDB persistent cache enabled; unavailable হলে memory cache fallback হয়।
- Firebase Storage app ব্যবহার করে না, তাই default rule সব Storage access বন্ধ রাখে।

## Clean cut-over

পুরোনো localStorage test data Firebase-এ upload/migrate হয় না। Production শুরু হবে একেবারে empty transaction, budget, master এবং settings দিয়ে। Browser-এর local test data প্রয়োজন না হলে DevTools → Application → Local Storage থেকে `vcf_`-prefix key-গুলো পরে manually clear করা যাবে।
