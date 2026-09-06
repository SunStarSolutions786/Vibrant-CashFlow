// Firebase modular browser adapter. The UI uses one-shot queries only; there
// are intentionally no realtime listeners that keep billing reads while idle.
if (window.VCF_USE_FIREBASE) {
  try {
    const appSdk = await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-app.js');
    const fs = await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-firestore.js');
    const authSdk = await import('https://www.gstatic.com/firebasejs/12.2.1/firebase-auth.js');
    const app = appSdk.initializeApp(window.VCF_FIREBASE_CONFIG);
    let db;
    try {
      db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch (error) {
      console.warn('Persistent Firebase cache unavailable; using memory cache.', error);
      db = fs.getFirestore(app);
    }
    const auth = authSdk.getAuth(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);

    const clean = (value) => {
      if (Array.isArray(value)) return value.map(clean);
      if (value && typeof value === 'object' && !(value instanceof Date)) {
        const out = {};
        Object.entries(value).forEach(([key, item]) => { if (item !== undefined) out[key] = clean(item); });
        return out;
      }
      return value;
    };
    const fromSnap = (snapshot) => ({ id: snapshot.id, ...snapshot.data() });
    const chunks = (list, size) => {
      const out = [];
      for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
      return out;
    };
    const monthOf = (item) => String(item.month || item.date || '').slice(0, 7);

    function queryConstraints(options = {}, after) {
      const out = [];
      (options.filters || []).forEach(({ field, op = '==', value }) => {
        if (value !== undefined && value !== null && value !== '') out.push(fs.where(field, op, value));
      });
      (options.orders || []).forEach(({ field, direction = 'asc' }) => {
        out.push(fs.orderBy(field === '__name__' ? fs.documentId() : field, direction));
      });
      if (after) out.push(fs.startAfter(...after));
      if (options.limit) out.push(fs.limit(options.limit));
      return out;
    }

    async function list(collectionName, options = {}) {
      const q = fs.query(fs.collection(db, collectionName), ...queryConstraints(options));
      return (await fs.getDocs(q)).docs.map(fromSnap);
    }

    async function listAll(collectionName, options = {}) {
      const pageSize = Math.max(50, Number(options.pageSize) || 500);
      const maxRows = Math.max(pageSize, Number(options.maxRows) || 100000);
      const orders = options.orders && options.orders.length ? options.orders.slice() : [{ field: '__name__', direction: 'asc' }];
      if (!orders.some((item) => item.field === '__name__')) orders.push({ field: '__name__', direction: 'asc' });
      const all = [];
      let after = null;
      while (all.length < maxRows) {
        const pageOptions = { ...options, orders, limit: Math.min(pageSize, maxRows - all.length) };
        const q = fs.query(fs.collection(db, collectionName), ...queryConstraints(pageOptions, after));
        const snapshot = await fs.getDocs(q);
        snapshot.docs.forEach((item) => all.push(fromSnap(item)));
        if (snapshot.size < pageOptions.limit) return all;
        const last = snapshot.docs[snapshot.docs.length - 1];
        after = orders.map((order) => order.field === '__name__' ? last.id : last.get(order.field));
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      throw new Error(`The selected export contains more than ${maxRows.toLocaleString()} rows. Select a smaller date range.`);
    }

    async function getOne(collectionName, id, fallback = null) {
      const snapshot = await fs.getDoc(fs.doc(db, collectionName, id));
      return snapshot.exists() ? fromSnap(snapshot) : fallback;
    }

    async function setOne(collectionName, id, value, merge = false) {
      const record = clean(value);
      delete record.id;
      await fs.setDoc(fs.doc(db, collectionName, id), record, { merge });
      return { id, ...record };
    }

    async function putMany(collectionName, values, options = {}) {
      const rows = (values || []).map(clean);
      for (const part of chunks(rows, 400)) {
        const batch = fs.writeBatch(db);
        part.forEach((item) => {
          if (!item.id) throw new Error(`A ${collectionName} row has no id.`);
          const record = { ...item };
          delete record.id;
          batch.set(fs.doc(db, collectionName, item.id), record, { merge: options.merge !== false });
        });
        await batch.commit();
      }
      const months = Array.from(new Set(rows.map(monthOf).filter(Boolean)));
      if (months.length && collectionName !== 'dataMonths') {
        await putMany('dataMonths', months.map((month) => ({ id: month, month, updatedAt: new Date().toISOString() })));
      }
      return rows;
    }

    async function deleteOne(collectionName, id) {
      await fs.deleteDoc(fs.doc(db, collectionName, id));
    }

    async function deleteMany(collectionName, ids) {
      for (const part of chunks(ids || [], 450)) {
        const batch = fs.writeBatch(db);
        part.forEach((id) => batch.delete(fs.doc(db, collectionName, id)));
        await batch.commit();
      }
    }

    async function upsertTransactions(values) {
      const results = [];
      for (const part of chunks(values || [], 90)) {
        const saved = await fs.runTransaction(db, async (transaction) => {
          const refs = part.map((item) => fs.doc(db, 'transactions', item.id));
          const snapshots = [];
          for (const ref of refs) snapshots.push(await transaction.get(ref));
          return part.map((incoming, index) => {
            const old = snapshots[index].exists() ? fromSnap(snapshots[index]) : null;
            const expected = Object.prototype.hasOwnProperty.call(incoming, '_expectedRevision');
            const currentRevision = old ? Number(old._revision) || 0 : null;
            if (expected && Number(incoming._expectedRevision) !== currentRevision) {
              throw new Error('A transaction changed in another tab. Reload Categorize and review your changes before saving again.');
            }
            const next = clean({ ...(old || {}), ...incoming, _revision: (currentRevision == null ? 0 : currentRevision) + 1 });
            delete next._expectedRevision;
            const record = { ...next };
            delete record.id;
            transaction.set(refs[index], record);
            return next;
          });
        });
        results.push(...saved);
      }
      const months = Array.from(new Set(results.map(monthOf).filter(Boolean)));
      if (months.length) await putMany('dataMonths', months.map((month) => ({ id: month, month })));
      return results;
    }

    async function existingImportHashes(hashes) {
      const found = new Set();
      for (const part of chunks(Array.from(new Set((hashes || []).filter(Boolean))), 30)) {
        const rows = await list('transactions', { filters: [{ field: 'importHash', op: 'in', value: part }] });
        rows.forEach((item) => { if (item.importHash) found.add(item.importHash); });
      }
      return found;
    }

    async function dashboard(month, bankAccountIds) {
      const recent = await list('transactions', {
        orders: [{ field: 'createdAt', direction: 'desc' }],
        limit: 8,
      });
      // A brand-new production database has no transaction indexes to scan.
      // Return the correct zero state immediately and avoid unnecessary
      // aggregate/index requests during first-time setup.
      if (recent.length === 0) {
        return {
          totalInflow: 0,
          totalOutflow: 0,
          monthInflow: 0,
          monthOutflow: 0,
          uncategorized: 0,
          recent: [],
          latestBalances: [],
        };
      }
      const aggregate = async (selectedMonth) => {
        const filters = selectedMonth ? [{ field: 'month', value: selectedMonth }] : [];
        const q = fs.query(fs.collection(db, 'transactions'), ...queryConstraints({ filters }));
        const data = (await fs.getAggregateFromServer(q, {
          inflow: fs.sum('inflowNet'), outflow: fs.sum('outflowNet'),
        })).data();
        return { inflow: Number(data.inflow) || 0, outflow: Number(data.outflow) || 0 };
      };
      const pendingQuery = fs.query(fs.collection(db, 'transactions'), fs.where('status', '==', 'uncategorized'));
      const [totals, monthTotals, pending] = await Promise.all([
        aggregate(''), aggregate(month),
        fs.getCountFromServer(pendingQuery),
      ]);
      const latestBalances = (await Promise.all((bankAccountIds || []).map(async (accountId) => {
        try {
          const rows = await list('transactions', {
            filters: [{ field: 'bankAccountId', value: accountId }, { field: 'hasClosingBalance', value: true }],
            orders: [{ field: 'date', direction: 'desc' }, { field: 'statementRowOrder', direction: 'desc' }],
            limit: 1,
          });
          return rows[0] || null;
        } catch (error) {
          // A not-yet-built optional balance index must not block the entire
          // dashboard. Firestore logs a direct index-creation link in console.
          console.warn('Latest bank balance query unavailable for', accountId, error);
          return null;
        }
      }))).filter(Boolean);
      return {
        totalInflow: totals.inflow,
        totalOutflow: totals.outflow,
        monthInflow: monthTotals.inflow,
        monthOutflow: monthTotals.outflow,
        uncategorized: pending.data().count,
        recent,
        latestBalances,
      };
    }

    async function createUser(email, password) {
      const secondary = appSdk.initializeApp(window.VCF_FIREBASE_CONFIG, `provision-${Date.now()}-${Math.random()}`);
      try {
        const secondaryAuth = authSdk.getAuth(secondary);
        const credential = await authSdk.createUserWithEmailAndPassword(secondaryAuth, email, password);
        await authSdk.signOut(secondaryAuth);
        return credential.user.uid;
      } finally {
        await appSdk.deleteApp(secondary);
      }
    }

    window.FirebaseBridge = {
      list, listAll, getOne, setOne, putMany, deleteOne, deleteMany,
      upsertTransactions, existingImportHashes, dashboard,
      auth: {
        async current() { await auth.authStateReady(); return auth.currentUser; },
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
}
