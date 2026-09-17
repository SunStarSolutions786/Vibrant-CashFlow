// All financial writes and their month/audit records commit together.
function createFirebaseRepository(fs, db, actor) {
  const clean = (value) => {
    if (value && typeof value.toDate === 'function') return value;
    if (Array.isArray(value)) return value.map(clean);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
      return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, clean(v)]));
    }
    return value;
  };
  const data = (item) => { const row = clean(item); delete row.id; return row; };
  const fromSnap = (s) => ({ ...s.data(), id: s.id });
  const ref = (collection, id) => fs.doc(db, collection, id);
  const chunks = (rows, size) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));
  const knownMonths = new Set();
  const rememberMonths = (rows) => rows.forEach((r) => { const month = String(r.month || r.date || '').slice(0, 7); if (month) knownMonths.add(month); });
  function watchDocument(collection, id, callback, onError) {
    return fs.onSnapshot(ref(collection, id), { includeMetadataChanges: true }, (snap) => {
      if (!snap.metadata?.fromCache && !snap.metadata?.hasPendingWrites) callback(snap.exists() ? fromSnap(snap) : null);
    }, onError);
  }
  function constraints(options = {}) {
    const result = (options.filters || []).filter((f) => f.value !== '' && f.value != null)
      .map((f) => fs.where(f.field === '__name__' ? fs.documentId() : f.field, f.op || '==', f.value));
    (options.orders || []).forEach((o) => result.push(fs.orderBy(o.field === '__name__' ? fs.documentId() : o.field, o.direction || 'asc')));
    if (options.after) result.push(fs.startAfter(...options.after));
    if (options.limit) result.push(fs.limit(options.limit));
    return result;
  }
  async function list(collection, options = {}) {
    const rows = (await fs.getDocsFromServer(fs.query(fs.collection(db, collection), ...constraints(options)))).docs.map(fromSnap);
    if (collection === 'dataMonths') rememberMonths(rows);
    return rows;
  }
  async function listPage(collection, options = {}) {
    const orders = options.orders?.length ? options.orders.slice() : [{ field: '__name__', direction: 'asc' }];
    if (!orders.some((o) => o.field === '__name__')) orders.push({ field: '__name__', direction: orders.at(-1).direction || 'asc' });
    const limit = options.limit || 250;
    const rows = await list(collection, { ...options, orders, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const last = page.at(-1);
    return { rows: page, hasMore, cursor: last ? orders.map((o) => o.field === '__name__' ? last.id : last[o.field]) : null };
  }
  async function listAll(collection, options = {}) {
    const rows = [];
    const max = options.maxRows || 100000;
    let after = null;
    do {
      const page = await listPage(collection, { ...options, after, limit: Math.min(options.pageSize || 500, max - rows.length) });
      rows.push(...page.rows);
      if (!page.hasMore) return rows;
      if (rows.length >= max) throw new Error(`More than ${max.toLocaleString()} records match. Select a smaller date range.`);
      after = page.cursor;
    } while (after);
    return rows;
  }
  async function getOne(collection, id, fallback = null) {
    const snap = await fs.getDocFromServer(ref(collection, id));
    return snap.exists() ? fromSnap(snap) : fallback;
  }
  async function setOne(collection, id, value, merge = false) {
    await fs.setDoc(ref(collection, id), data(value), { merge });
    return { ...value, id };
  }
  async function saveRevisioned(collection, id, value, expected, message) {
    return fs.runTransaction(db, async (tx) => {
      const snap = await tx.get(ref(collection, id));
      const revision = snap.exists() ? Number(snap.data()._revision) || 0 : 0;
      if (revision !== expected) throw new Error(message || 'This record changed elsewhere. Reload before saving.');
      const next = { ...value, _revision: revision + 1 };
      tx.set(ref(collection, id), data(next));
      return next;
    });
  }
  function registerMonths(tx, rows) {
    new Set(rows.map((r) => String(r.month || r.date || '').slice(0, 7)).filter(Boolean))
      .forEach((month) => { if (!knownMonths.has(month)) tx.set(ref('dataMonths', month), { month }); });
  }
  function partialError(error, savedRows, requested) {
    const wrapped = new Error(`${savedRows.length} of ${requested} rows saved. ${error.message || 'The remaining rows could not be saved.'} Retry to resume; completed rows will not be duplicated.`);
    wrapped.savedRows = savedRows;
    wrapped.cause = error;
    wrapped.code = error.code;
    return wrapped;
  }
  async function upsertTransactions(values) {
    const savedRows = [];
    const uid = actor();
    if (!uid) throw new Error('Sign in again before saving.');
    // Four updates fit the security-rule access budget even when every row
    // has a distinct month, before/after state and separate history record.
    try {
      for (const part of chunks(values, 4)) {
        const saved = await fs.runTransaction(db, async (tx) => {
          const snapshots = await Promise.all(part.map((r) => tx.get(ref('transactions', r.id))));
          const nextRows = part.map((incoming, i) => {
            const old = snapshots[i].exists() ? fromSnap(snapshots[i]) : null;
            if (old && incoming._operationId && old._operationId === incoming._operationId) return old;
            const revision = old ? Number(old._revision) || 0 : 0;
            if (old && incoming._expectedRevision !== revision) throw new Error('A transaction changed elsewhere. Reload and review that row.');
            if (!old && incoming._expectedRevision != null) throw new Error('The transaction no longer exists. Reload before saving.');
            const next = { ...old, ...incoming, _revision: revision + 1, updatedBy: uid };
            delete next._expectedRevision;
            if (!old) next.createdBy = uid;
            if (old) tx.set(fs.doc(db, 'transactions', incoming.id, 'history', String(revision + 1)), {
              before: data(old), actor: uid, reason: incoming.changeReason || 'Category update', savedAt: fs.serverTimestamp(),
            });
            tx.set(ref('transactions', incoming.id), { ...data(next), savedAt: fs.serverTimestamp() });
            return next;
          });
          registerMonths(tx, nextRows);
          return nextRows;
        });
        rememberMonths(saved);
        savedRows.push(...saved);
      }
      return savedRows;
    } catch (error) { throw partialError(error, savedRows, values.length); }
  }
  async function importTransactions(rows, allowDuplicates) {
    const uid = actor();
    if (!uid) throw new Error('Sign in again before importing.');
    const savedRows = [];
    let duplicates = 0, acceptedDuplicates = 0;
    try {
      for (const part of chunks(rows, 8)) {
        const result = await fs.runTransaction(db, async (tx) => {
          const originals = await Promise.all(part.map((r) => tx.get(ref('transactions', `import_${r.importHash}`))));
          const copies = allowDuplicates ? await Promise.all(part.map((r) => tx.get(ref('transactions', `import_${r.importHash}:accepted:${r.id}`)))) : [];
          const saved = [], months = [];
          let skipped = 0, copiesSaved = 0;
          part.forEach((incoming, i) => {
            const original = originals[i].exists() ? fromSnap(originals[i]) : null;
            const ownRetry = original && original.importBatchId === incoming.importBatchId;
            const duplicate = !ownRetry && original;
            if (duplicate && !allowDuplicates) { skipped++; return; }
            if (ownRetry) { saved.push(original); return; }
            if (duplicate && copies[i].exists()) { saved.push(fromSnap(copies[i])); copiesSaved++; return; }
            const hash = duplicate ? `${incoming.importHash}:accepted:${incoming.id}` : incoming.importHash;
            const next = { ...incoming, id: `import_${hash}`, importHash: hash, _revision: 1, createdBy: uid, updatedBy: uid };
            if (duplicate) { next.duplicateOfHash = incoming.importHash; copiesSaved++; }
            months.push(next);
            tx.set(ref('transactions', next.id), { ...data(next), savedAt: fs.serverTimestamp() });
            saved.push(next);
          });
          registerMonths(tx, months);
          return { saved, skipped, copiesSaved };
        });
        rememberMonths(result.saved);
        savedRows.push(...result.saved); duplicates += result.skipped; acceptedDuplicates += result.copiesSaved;
      }
      return { transactions: savedRows, inserted: savedRows.length, duplicates, acceptedDuplicates };
    } catch (error) { throw partialError(error, savedRows, rows.length); }
  }
  // `known` = { revision, rows } already verified for this month. Every budget
  // write bumps the month lock (enforced by rules), so if the lock still has that
  // revision inside the transaction, the known rows are exactly current and the
  // month does not need to be read again.
  async function saveBudgets(month, items, expected, changedIds, replace, known = null) {
    const lockRef = ref('budgetLocks', month);
    const before = known ? { revision: known.revision } : await getOne('budgetLocks', month, { revision: 0 });
    const current = known ? known.rows : await listAll('budgets', { filters: [{ field: 'month', value: month }] });
    const bySub = new Map();
    current.forEach((r) => {
      if (bySub.has(r.subHeadId)) throw new Error('This month contains duplicate budget categories. Reconcile the existing duplicate records before saving.');
      bySub.set(r.subHeadId, r);
    });
    const changed = new Set(replace ? [...bySub.keys(), ...items.map((r) => r.subHeadId)] : changedIds);
    if (replace && Object.keys(expected).length !== bySub.size) throw new Error('This month changed elsewhere. Reload before replacing it.');
    changed.forEach((id) => {
      const revision = bySub.has(id) ? Number(bySub.get(id)._revision) || 0 : null;
      if ((expected[id] ?? null) !== revision) throw new Error('Budget & Booking changed elsewhere. Reload and review before saving.');
    });
    const next = items.map((r) => ({ ...r, id: bySub.get(r.subHeadId)?.id || `${month}__${encodeURIComponent(r.subHeadId)}`,
      categorySnapshot: bySub.get(r.subHeadId)?.categorySnapshot || r.categorySnapshot,
      _revision: (Number(bySub.get(r.subHeadId)?._revision) || 0) + 1, updatedBy: actor() }));
    const savedSubs = new Set(next.map((r) => r.subHeadId));
    const removed = current.filter((r) => changed.has(r.subHeadId) && !savedSubs.has(r.subHeadId));
    if (next.length + removed.length > 450) throw new Error('Save at most 450 budget rows at once. Split this edit into smaller groups; nothing was saved.');
    await fs.runTransaction(db, async (tx) => {
      const lock = await tx.get(lockRef);
      const revision = lock.exists() ? lock.data().revision : 0;
      if (revision !== before.revision) throw new Error('This month changed while you were saving. Reload and review before saving again.');
      // The month lock is enforced by rules on every budget write, including
      // deletes, so a query outside the transaction cannot miss a concurrent row.
      tx.set(lockRef, { revision: revision + 1 });
      removed.forEach((r) => tx.delete(ref('budgets', r.id)));
      next.forEach((r) => tx.set(ref('budgets', r.id), data(r)));
      registerMonths(tx, [{ month }]);
    });
    rememberMonths([{ month }]);
    const rows = [...current.filter((r) => !changed.has(r.subHeadId)), ...next.map((r) => ({ ...data(r), id: r.id }))];
    return { saved: next, revision: before.revision + 1, rows };
  }
  async function dashboard(month, bankIds) {
    const recent = await list('transactions', { orders: [{ field: 'createdAt', direction: 'desc' }], limit: 8 });
    if (!recent.length) return { totalInflow: 0, totalOutflow: 0, monthInflow: 0, monthOutflow: 0, uncategorized: 0, recent: [], latestBalances: [], selections: [] };
    // One query for all balance selections instead of one read per bank account.
    const selections = bankIds.length ? await balanceSelections() : [];
    const aggregate = async (selectedMonth) => {
      const options = { filters: selectedMonth ? [{ field: 'month', value: selectedMonth }] : [] };
      return (await fs.getAggregateFromServer(fs.query(fs.collection(db, 'transactions'), ...constraints(options)), {
        inflow: fs.sum('inflowNet'), outflow: fs.sum('outflowNet'),
      })).data();
    };
    const [totals, monthly, pending, balances] = await Promise.all([
      aggregate(''), aggregate(month), fs.getCountFromServer(fs.query(fs.collection(db, 'transactions'), fs.where('status', '==', 'uncategorized'))),
      Promise.all(bankIds.map(async (id) => {
        const filters = [{ field: 'bankAccountId', value: id }, { field: 'hasClosingBalance', value: true }];
        const latest = await list('transactions', { filters, orders: [{ field: 'date', direction: 'desc' }], limit: 1 });
        if (!latest.length) return null;
        const rows = await listAll('transactions', { filters: [...filters, { field: 'date', value: latest[0].date }] });
        const selection = selections.find((item) => item.id === id);
        const selected = selection && rows.find((r) => r.id === selection.transactionId);
        if (selected && selection.date === latest[0].date && selection.candidatesKey === await Utils.balanceCandidatesKey(rows)) {
          return { ...selected, balanceConfirmed: true, balanceCandidates: rows };
        }
        return { ...Utils.latestStatementBalance(rows), balanceCandidates: rows };
      })),
    ]);
    return { totalInflow: Number(totals.inflow) || 0, totalOutflow: Number(totals.outflow) || 0,
      monthInflow: Number(monthly.inflow) || 0, monthOutflow: Number(monthly.outflow) || 0,
      uncategorized: pending.data().count, recent, latestBalances: balances.filter(Boolean), selections };
  }
  async function balanceSelections() {
    return listAll('bankBalanceSelections', {});
  }

  // ---- Change feed ------------------------------------------------------------------
  // Every transaction write stamps savedAt with the server commit time and the
  // rules forbid deleting transactions, so "saved after cursor" is a complete
  // change log. A cursor is { seconds, nanoseconds, id } (plain data, storable).
  const changeOrder = [{ field: 'savedAt', direction: 'asc' }, { field: '__name__', direction: 'asc' }];
  const cursorAfter = (cursor) => {
    const time = Utils.timestampFromStamp(fs, cursor);
    return cursor.id ? [time, cursor.id] : [time];
  };
  const cursorOf = (row) => ({ ...Utils.stampOf(row.savedAt), id: row.id });
  async function latestChange() {
    const rows = await list('transactions', { orders: [{ field: 'savedAt', direction: 'desc' }, { field: '__name__', direction: 'desc' }], limit: 1 });
    return rows.length ? cursorOf(rows[0]) : { seconds: 0, nanoseconds: 0, id: '' };
  }
  async function changesSince(cursor, limit = 500) {
    const page = await listPage('transactions', { orders: changeOrder, after: cursorAfter(cursor), limit });
    return { rows: page.rows, hasMore: page.hasMore, cursor: page.rows.length ? cursorOf(page.rows.at(-1)) : cursor };
  }
  async function hasChangesSince(cursor) {
    return (await list('transactions', { orders: changeOrder, after: cursorAfter(cursor), limit: 1 })).length > 0;
  }
  async function countChangesSince(cursor) {
    const query = fs.query(fs.collection(db, 'transactions'), fs.where('savedAt', '>', Utils.timestampFromStamp(fs, cursor)));
    return (await fs.getCountFromServer(query)).data().count;
  }
  // Server-side totals for one month: about one billed read per 1,000 records.
  async function monthTotals(month) {
    const query = fs.query(fs.collection(db, 'transactions'), fs.where('month', '==', month));
    const totals = (await fs.getAggregateFromServer(query, { count: fs.count(), inflow: fs.sum('inflowNet'), outflow: fs.sum('outflowNet') })).data();
    return { count: Number(totals.count) || 0, inflow: Number(totals.inflow) || 0, outflow: Number(totals.outflow) || 0 };
  }
  async function budgetLockRevisions(months) {
    const revisions = Object.fromEntries(months.map((month) => [month, 0]));
    for (const part of chunks(months, 30)) {
      (await list('budgetLocks', { filters: [{ field: '__name__', op: 'in', value: part }] }))
        .forEach((lock) => { revisions[lock.id] = Number(lock.revision) || 0; });
    }
    return revisions;
  }
  async function confirmBankBalance(bankAccountId, transactionId, expectedDate) {
    const filters = [{ field: 'bankAccountId', value: bankAccountId }, { field: 'hasClosingBalance', value: true }];
    const latest = await list('transactions', { filters, orders: [{ field: 'date', direction: 'desc' }], limit: 1 });
    if (!latest.length || latest[0].date !== expectedDate) throw new Error('A newer statement arrived. Refresh the dashboard and review it.');
    const candidates = await listAll('transactions', { filters: [...filters, { field: 'date', value: expectedDate }] });
    if (!candidates.some((r) => r.id === transactionId)) throw new Error('This balance changed. Refresh and review again.');
    return setOne('bankBalanceSelections', bankAccountId, { transactionId, date: expectedDate,
      candidatesKey: await Utils.balanceCandidatesKey(candidates), selectedBy: actor(), selectedAt: new Date().toISOString() });
  }
  async function reconcileBudgetDuplicates(month, subHeadId, keepId, expectedKey) {
    const lock = await getOne('budgetLocks', month, { revision: 0 });
    const candidates = (await listAll('budgets', { filters: [{ field: 'month', value: month }] })).filter((r) => r.subHeadId === subHeadId);
    if (Utils.budgetRevisionKey(candidates) !== expectedKey) throw new Error('These budgets changed. Reload before reconciling.');
    const keep = candidates.find((r) => r.id === keepId);
    if (!keep || candidates.length < 2) throw new Error('These duplicate budgets are no longer available. Reload.');
    if (candidates.length > 450) throw new Error('Too many duplicate rows to reconcile in one operation. Contact your administrator.');
    await fs.runTransaction(db, async (tx) => {
      const currentLock = await tx.get(ref('budgetLocks', month));
      if ((currentLock.exists() ? currentLock.data().revision : 0) !== lock.revision) throw new Error('Budget data changed while reconciling. Reload and try again.');
      // Keep the reviewed values; archive removed records in the same commit.
      tx.set(ref('budgetLocks', month), { revision: lock.revision + 1 });
      candidates.filter((r) => r.id !== keepId).forEach((r) => tx.delete(ref('budgets', r.id)));
      tx.set(ref('budgets', keep.id), data({ ...keep, _revision: (Number(keep._revision) || 0) + 1, updatedBy: actor() }));
      tx.set(ref('budgetReconciliations', `${month}__${encodeURIComponent(subHeadId)}__${lock.revision + 1}`), {
        month, subHeadId, keptId: keepId, before: candidates.map(data), actor: actor(), savedAt: fs.serverTimestamp(),
      });
      registerMonths(tx, [{ month }]);
    });
  }
  async function pruneMappings(isValid) {
    return fs.runTransaction(db, async (tx) => {
      const target = ref('appData', 'mappingMemory');
      const snap = await tx.get(target);
      const entries = snap.exists() ? snap.data().entries || [] : [];
      const valid = entries.filter((item) => isValid(item.mapping));
      if (valid.length !== entries.length) tx.set(target, { entries: valid });
      return Object.fromEntries(valid.map((item) => [item.key, item.mapping]));
    });
  }
  async function rememberMappings(items, maxEntries) {
    return fs.runTransaction(db, async (tx) => {
      const target = ref('appData', 'mappingMemory');
      const snap = await tx.get(target);
      const entries = snap.exists() ? snap.data().entries || [] : [];
      const memory = new Map(entries.map((item) => [item.key, item.mapping]));
      let changed = false;
      for (const item of items) {
        const old = memory.get(item.key);
        if (old && ['type', 'verticalId', 'headId', 'subHeadId'].every((key) => old[key] === item.mapping[key])) continue;
        memory.delete(item.key); memory.set(item.key, item.mapping); changed = true;
      }
      const bounded = [...memory.entries()].slice(-maxEntries);
      if (changed) tx.set(target, { entries: bounded.map(([key, mapping]) => ({ key, mapping })) });
      return Object.fromEntries(bounded);
    });
  }
  return { list, listPage, listAll, getOne, setOne, saveRevisioned, upsertTransactions,
    importTransactions, watchDocument, rememberMappings, pruneMappings, saveBudgets, dashboard, confirmBankBalance, reconcileBudgetDuplicates,
    latestChange, changesSince, hasChangesSince, countChangesSince, monthTotals, budgetLockRevisions, balanceSelections,
    deleteOne: (collection, id) => fs.deleteDoc(ref(collection, id)) };
}
