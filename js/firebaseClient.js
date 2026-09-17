// Firebase adapter. Financial queries are on demand. Only three small metadata
// documents are watched so navigation can reuse them without stale permissions.
// Report data is kept by the app's own local store (localStore.js), so the SDK
// uses a memory cache: large reads are not written to browser storage twice.
try {
    const appSdk = await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js');
    const fs = await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js');
    const authSdk = await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js');
    const app = appSdk.initializeApp(window.VCF_FIREBASE_CONFIG);
    let db;
    try {
      db = fs.initializeFirestore(app, {
        localCache: fs.memoryLocalCache({ garbageCollector: fs.memoryEagerGarbageCollector() }),
      });
    } catch (error) {
      console.warn('Firebase memory cache settings unavailable; using defaults.', error);
      db = fs.getFirestore(app);
    }
    const auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);

    const repository = createFirebaseRepository(fs, db, () => auth.currentUser && auth.currentUser.uid);

    async function createUser(email, password, profile) {
      const secondary = appSdk.initializeApp(window.VCF_FIREBASE_CONFIG, 'provision-' + Date.now() + '-' + Math.random());
      const secondaryAuth = authSdk.getAuth(secondary);
      try {
        await authSdk.setPersistence(secondaryAuth, authSdk.inMemoryPersistence);
        return await provisionAccount({
          create: (email, password) => authSdk.createUserWithEmailAndPassword(secondaryAuth, email, password),
          signIn: (email, password) => authSdk.signInWithEmailAndPassword(secondaryAuth, email, password),
          deleteCreated: (user) => authSdk.deleteUser(user),
          findProfile: (id) => repository.getOne('users', id),
          saveProfile: (id, profile) => repository.setOne('users', id, profile),
        }, email, password, profile);
      } finally {
        await authSdk.signOut(secondaryAuth).catch(() => {});
        await appSdk.deleteApp(secondary);
      }
    }

    window.FirebaseBridge = {
      ...repository,
      auth: {
        async current() { await auth.authStateReady(); return auth.currentUser; },
        onChange(callback) { return authSdk.onAuthStateChanged(auth, callback); },
        async login(email, password) { return (await authSdk.signInWithEmailAndPassword(auth, email, password)).user; },
        async logout() { await authSdk.signOut(auth); },
        createUser,
        async sendPasswordReset(email) { await authSdk.sendPasswordResetEmail(auth, email); },
      },
    };
    window.vcfResolveFirebase(window.FirebaseBridge);
} catch (error) {
  console.error('Firebase initialization failed', error);
  window.vcfRejectFirebase(error);
}
