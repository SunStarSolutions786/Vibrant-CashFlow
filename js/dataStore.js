// ============================================================================
// VIBRANT CashFlow — production Firebase data layer.
// Each screen requests only its own date/status range. Reports read a local
// copy that is brought up to date from a change feed (see "Local report data").
// ============================================================================

async function firebaseBridge() {
  const bridge = await window.VCF_FIREBASE_READY;
  if (!bridge) throw new Error('Firebase could not be initialized.');
  return bridge;
}

function withoutDocumentId(value, fallback) {
  if (!value) return fallback;
  const copy = { ...value };
  delete copy.id;
  return copy;
}

function transactionQueryOptions(options = {}) {
  const filters = [];
  if (options.status) filters.push({ field: 'status', value: options.status });
  if (options.fromDate) filters.push({ field: 'date', op: '>=', value: options.fromDate });
  if (options.toDate) filters.push({ field: 'date', op: '<=', value: options.toDate });
  return { filters, orders: [{ field: 'date', direction: 'desc' }], pageSize: FIREBASE_EXPORT_PAGE_SIZE, maxRows: FIREBASE_EXPORT_MAX_ROWS };
}

function normalizeTransaction(item) {
  const closing = item && item.closingBalance;
  const categorized = item && item.status === TXN_STATUS.CATEGORIZED;
  return {
    ...item,
    month: Utils.monthKey(item && item.date),
    hasClosingBalance: item.status !== 'void' && closing !== '' && closing != null && Number.isFinite(Number(closing)),
    inflowNet: categorized && item.type === TXN_TYPE.INFLOW ? Utils.netCash(item) : 0,
    outflowNet: categorized && item.type === TXN_TYPE.OUTFLOW ? Utils.netOutflow(item) : 0,
  };
}

const FirebaseBackend = {
  async getUsers() {
    return (await firebaseBridge()).listAll('users', {
      orders: [{ field: 'name', direction: 'asc' }],
    });
  },
  async getUser(id) { return (await firebaseBridge()).getOne('users', id, null); },
  async upsertUser(user) { return (await firebaseBridge()).setOne('users', user.id, user, false); },
  async deleteUser(id) { return (await firebaseBridge()).deleteOne('users', id); },

  async getMasterData() {
    const fallback = { verticals: [], heads: [], subHeads: [], bankAccounts: [], _revision: 0 };
    return withoutDocumentId(await (await firebaseBridge()).getOne('appData', 'masterData', null), fallback);
  },
  async saveMasterData(data) {
    const bridge = await firebaseBridge();
    const saved = await bridge.saveRevisioned(
      'appData', 'masterData', data, Number(data && data._revision) || 0,
      'Master Data changed in another browser. Reload this page and apply your change again.',
    );
    return withoutDocumentId(saved, null);
  },

  async getTransactions(fromDate, toDate) {
    return (await firebaseBridge()).listAll('transactions', transactionQueryOptions({ fromDate, toDate }));
  },
  async upsertTransactions(list) {
    return (await firebaseBridge()).upsertTransactions((list || []).map(normalizeTransaction));
  },
  async dashboard(month, bankIds) { return (await firebaseBridge()).dashboard(month, bankIds); },

  async getBudgets(fromMonth, toMonth) {
    return (await firebaseBridge()).listAll('budgets', {
      filters: [{ field: 'month', op: '>=', value: fromMonth }, { field: 'month', op: '<=', value: toMonth }],
      orders: [{ field: 'month', direction: 'desc' }], pageSize: FIREBASE_EXPORT_PAGE_SIZE, maxRows: FIREBASE_EXPORT_MAX_ROWS,
    });
  },
  async getSettings() {
    return withoutDocumentId(await (await firebaseBridge()).getOne('appData', 'settings', null), null);
  },
  async saveSettings(settings) {
    return withoutDocumentId(await (await firebaseBridge()).setOne('appData', 'settings', settings, false), null);
  },
  async getMappingMemory() {
    const raw = withoutDocumentId(await (await firebaseBridge()).getOne('appData', 'mappingMemory', null), {});
    if (Array.isArray(raw.entries)) {
      return Object.fromEntries(raw.entries
        .filter((item) => item && Utils.mappingMemoryKey(item.key) && item.mapping)
        .map((item) => [Utils.mappingMemoryKey(item.key), item.mapping]));
    }
    return {};
  },
  async getAvailableMonths() {
    const rows = await (await firebaseBridge()).list('dataMonths', { orders: [{ field: 'month', direction: 'desc' }], limit: 600 });
    return rows.map((r) => r.month);
  },
};

const _cache = Object.create(null);
const _reads = Object.create(null);
const _writeQueues = Object.create(null);
const _versions = Object.create(null);
const _liveKeys = new Set();
// Small documents that only this browser changes in ways that matter to it
// (category suggestions): read once per session, updated locally after writes.
const SESSION_CACHE_KEYS = new Set(['mappingMemory']);

async function cachedGet(key, fetcher, fresh = false) {
  if (_writeQueues[key]) await _writeQueues[key].catch(() => {});
  // Reuse metadata kept current by a server listener, or session-cached documents.
  if (!fresh && (_liveKeys.has(key) || SESSION_CACHE_KEYS.has(key)) && Object.hasOwn(_cache, key)) return _cache[key];
  if (!fresh && _session && _session.first.has(key)) {
    try { return await _session.first.get(key).promise; } catch { /* listener failed: read directly below */ }
  }
  if (!_reads[key]) {
    const version = _versions[key] || 0;
    const read = Promise.resolve().then(fetcher).then((value) => {
      if ((_versions[key] || 0) === version) _cache[key] = value;
      if (_reads[key] === read) delete _reads[key];
      return value;
    }, (error) => {
      if (_reads[key] === read) delete _reads[key];
      throw error;
    });
    _reads[key] = read;
  }
  return _reads[key];
}

function serializedWrite(key, writer) {
  const before = _writeQueues[key] || Promise.resolve();
  const operation = before.catch(() => {}).then(async () => {
    _versions[key] = (_versions[key] || 0) + 1;
    delete _cache[key];
    if (navigator.locks && navigator.locks.request) {
      return navigator.locks.request(`vcf_${key}`, { mode: 'exclusive' }, writer);
    }
    return writer();
  });
  _writeQueues[key] = operation;
  operation.then(
    () => { if (_writeQueues[key] === operation) delete _writeQueues[key]; },
    () => { if (_writeQueues[key] === operation) delete _writeQueues[key]; },
  );
  return operation;
}

// ---- Local report data ---------------------------------------------------------------
// Reports read transactions from this browser's local store (localStore.js).
// Before each report the store asks Firebase only for records saved since its
// last check (normally a single billed read). Months are copied once per device,
// and each month shown is compared once per session with server-side count and
// totals (about one read per 1,000 records); any difference re-copies the month.
// If local storage or the change-feed index is unavailable, reports read Firebase
// directly for the rest of the session, exactly as before.
const CHANGE_PAGE_SIZE = 500;
const CHANGE_RESET_THRESHOLD = 20000;
const MONTH_LIST_REFRESH_MS = 6 * 60 * 60 * 1000;
const DASHBOARD_RECHECK_MS = 60 * 1000;
let _localStorePromise = null;
let _localDisabled = false;
let _syncChain = Promise.resolve();
let _dashboardCheckedAt = 0;
const _verifiedMonths = new Set();

function localStore() {
  if (!_localStorePromise) _localStorePromise = openLocalStore(window.VCF_FIREBASE_CONFIG && window.VCF_FIREBASE_CONFIG.projectId);
  return _localStorePromise;
}

function monthsBetween(fromMonth, toMonth) {
  const months = [];
  for (let month = fromMonth; month && month <= toMonth && months.length < 1200; month = Utils.addMonths(month, 1)) months.push(month);
  return months;
}

function contiguousRuns(months) {
  const runs = [];
  months.slice().sort().forEach((month) => {
    const run = runs.at(-1);
    if (run && Utils.addMonths(run.at(-1), 1) === month) run.push(month); else runs.push([month]);
  });
  return runs;
}

// Firestore Timestamps become plain { seconds, nanoseconds } before local storage.
function toStorable(value) {
  if (value && typeof value.toDate === 'function') return Utils.stampOf(value);
  if (Array.isArray(value)) return value.map(toStorable);
  if (value && typeof value === 'object' && !(value instanceof Date)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toStorable(v)]));
  return value;
}

// One sync at a time in this tab and, where supported, across tabs.
function exclusiveLocal(work) {
  const run = () => (navigator.locks && navigator.locks.request ? navigator.locks.request('vcf_local_sync', { mode: 'exclusive' }, work) : work());
  const result = _syncChain.then(run, run);
  _syncChain = result.catch(() => {});
  return result;
}

async function withLocal(work, direct) {
  if (_localDisabled) return direct();
  try {
    return await work(await localStore(), await firebaseBridge());
  } catch (error) {
    const code = String(error && error.code || '').toLowerCase();
    // Access, connectivity and range-size problems are real answers, not local-store faults.
    if (['permission-denied', 'unauthenticated', 'unavailable', 'deadline-exceeded'].some((c) => code.includes(c))
      || /^More than [\d,]+ records match/.test(String(error && error.message))) throw error;
    console.warn('Local report data is off for this session; reading Firebase directly.', error);
    _localDisabled = true;
    return direct();
  }
}

async function catchUp(store, bridge) {
  let state = await store.getMeta('sync');
  if (!state || state.schema !== LOCAL_STORE_SCHEMA) {
    // The cursor is taken before any month is copied, so nothing saved during a copy is missed.
    // Dashboard and budget entries validate themselves, so only transactions are discarded.
    const cursor = await bridge.latestChange();
    await store.clearTransactions();
    state = { schema: LOCAL_STORE_SCHEMA, cursor, covered: [], months: null, monthsAt: 0, sizeCheckedAt: Date.now() };
    await store.setMeta('sync', state);
    _verifiedMonths.clear();
    return state;
  }
  if (Date.now() - (state.sizeCheckedAt || 0) > MONTH_LIST_REFRESH_MS) {
    // After a long absence, re-copying the months in use is cheaper than replaying a huge backlog.
    if (await bridge.countChangesSince(state.cursor) > CHANGE_RESET_THRESHOLD) {
      await store.setMeta('sync', null);
      return catchUp(store, bridge);
    }
    state = { ...state, sizeCheckedAt: Date.now() };
  }
  for (;;) {
    const page = await bridge.changesSince(state.cursor, CHANGE_PAGE_SIZE);
    if (page.rows.length) {
      await store.putTransactions(page.rows.map(toStorable));
      const seen = page.rows.map((row) => row.month).filter(Boolean);
      if (state.months) state = { ...state, months: Array.from(new Set([...state.months, ...seen])).sort().reverse() };
    }
    state = { ...state, cursor: page.cursor };
    await store.setMeta('sync', state);
    if (!page.hasMore) return state;
  }
}

async function ensureMonths(store, bridge, state, months, reverify) {
  const covered = new Set(state.covered);
  const recopy = months.filter((month) => !covered.has(month));
  const check = months.filter((month) => covered.has(month) && (reverify || !_verifiedMonths.has(month)));
  if (check.length) {
    const [local, totals] = await Promise.all([
      store.transactionsForMonths(check[0], check.at(-1)),
      Promise.all(check.map((month) => bridge.monthTotals(month))),
    ]);
    const close = (a, b) => Math.abs(a - b) < 0.005;
    check.forEach((month, i) => {
      const rows = local.filter((row) => row.month === month);
      if (rows.length === totals[i].count && close(Utils.sumBy(rows, (r) => r.inflowNet), totals[i].inflow)
        && close(Utils.sumBy(rows, (r) => r.outflowNet), totals[i].outflow)) _verifiedMonths.add(month);
      else { console.warn('Local copy of ' + month + ' differed from Firebase; copying it again.'); recopy.push(month); }
    });
  }
  for (const run of contiguousRuns(recopy)) {
    const rows = await FirebaseBackend.getTransactions(`${run[0]}-01`, `${run.at(-1)}-31`);
    await store.replaceMonths(run, rows.map(toStorable));
    run.forEach((month) => { covered.add(month); _verifiedMonths.add(month); });
    state = { ...state, covered: Array.from(covered).sort() };
    await store.setMeta('sync', state);
  }
  return state;
}

async function availableMonthsFrom(store, state) {
  if (!state.months || Date.now() - (state.monthsAt || 0) > MONTH_LIST_REFRESH_MS) {
    state = { ...state, months: await FirebaseBackend.getAvailableMonths(), monthsAt: Date.now() };
    await store.setMeta('sync', state);
  }
  return state.months;
}

async function budgetsFor(store, bridge, fromMonth, toMonth) {
  const months = monthsBetween(fromMonth, toMonth);
  const [revisions, cached] = await Promise.all([
    bridge.budgetLockRevisions(months),
    Promise.all(months.map((month) => store.getMeta('budget:' + month))),
  ]);
  const byMonth = new Map(months.map((month, i) => [month, cached[i]]));
  const stale = months.filter((month) => !byMonth.get(month) || byMonth.get(month).revision !== revisions[month]);
  for (const run of contiguousRuns(stale)) {
    const rows = await FirebaseBackend.getBudgets(run[0], run.at(-1));
    for (const month of run) {
      // The revision was read first: a save in between only causes an extra copy next time.
      const entry = { revision: revisions[month], rows: toStorable(rows.filter((row) => row.month === month)) };
      byMonth.set(month, entry);
      await store.setMeta('budget:' + month, entry);
    }
  }
  // Same order as a server query: newest month first.
  return months.slice().reverse().flatMap((month) => byMonth.get(month).rows);
}

async function saveBudgetMonth(month, save) {
  const store = _localDisabled ? null : await localStore();
  const known = store ? await store.getMeta('budget:' + month).catch(() => null) : null;
  const result = await afterWrite(save(known || null));
  if (store) {
    await store.setMeta('budget:' + month, { revision: result.revision, rows: toStorable(result.rows) }).catch(() => {});
    const state = await store.getMeta('sync').catch(() => null);
    if (state && state.months && !state.months.includes(month)) {
      await store.setMeta('sync', { ...state, months: [...state.months, month].sort().reverse() }).catch(() => {});
    }
  }
  return result.saved;
}

function selectionsKey(selections) {
  return JSON.stringify((selections || []).map((s) => [s.id, s.transactionId, s.date, s.candidatesKey, s.selectedAt]).sort());
}

async function afterWrite(operation) {
  try { return await operation; } finally { _dashboardCheckedAt = 0; }
}

// ---- Metadata session ----------------------------------------------------------------
// The signed-in user's profile, Master Data and Settings are watched live. Reads
// made while those listeners start wait for their first values instead of paying
// for the same three documents twice.
let _session = null;
function metadataWatches(uid) {
  return [['user:' + uid, 'users', uid], ['masterData', 'appData', 'masterData'], ['settings', 'appData', 'settings']];
}

function startSession(uid) {
  if (_session && _session.uid === uid) return _session;
  stopSession();
  const session = { uid, stopped: false, stops: [], listeners: new Set(), errorListeners: new Set(), first: new Map(), error: null };
  metadataWatches(uid).forEach(([key]) => {
    const entry = {};
    entry.promise = new Promise((resolve, reject) => { entry.resolve = resolve; entry.reject = reject; });
    entry.promise.catch(() => {});
    session.first.set(key, entry);
  });
  _session = session;
  firebaseBridge().then((bridge) => {
    if (session.stopped) return;
    session.stops = metadataWatches(uid).map(([key, collection, id]) => bridge.watchDocument(collection, id, (raw) => {
      if (session.stopped) return;
      const value = key.startsWith('user:') ? raw : withoutDocumentId(raw, key === 'settings' ? { ...DEFAULT_SETTINGS } : { verticals: [], heads: [], subHeads: [], bankAccounts: [], _revision: 0 });
      _versions[key] = (_versions[key] || 0) + 1;
      delete _reads[key]; _cache[key] = value; _liveKeys.add(key);
      session.first.get(key).resolve(value);
      session.listeners.forEach((listener) => listener(key, value));
    }, (error) => {
      if (session.stopped) return;
      _liveKeys.delete(key); delete _cache[key];
      session.first.get(key).reject(error);
      session.error = error;
      session.errorListeners.forEach((listener) => listener(error));
    }));
  }, (error) => session.first.forEach((entry) => entry.reject(error)));
  return session;
}

function stopSession() {
  if (!_session) return;
  const session = _session;
  _session = null;
  session.stopped = true;
  session.stops.forEach((stop) => stop());
  metadataWatches(session.uid).forEach(([key]) => { _liveKeys.delete(key); delete _cache[key]; });
}

function snapshotSelection(masterData, item) {
  if (!item || item.categorySnapshot) return item;
  let snapshot = MasterHelpers.snapshotForSelection(masterData, item);
  if (!snapshot && item.subHeadId) {
    snapshot = MasterHelpers.snapshotForSelection(masterData, MasterHelpers.resolveChain(masterData, item.subHeadId));
  }
  return snapshot ? { ...item, categorySnapshot: snapshot } : item;
}

function snapshotBank(masterData, item) {
  if (!item || item.bankSnapshot || (!item.bankAccountId && !item.bankName)) return item;
  const account = (masterData.bankAccounts || []).find((entry) => entry.id === item.bankAccountId);
  const name = item.bankName || (account && account.name) || '';
  if (!name) return item;
  const verticalId = (account && account.verticalId) || '';
  return {
    ...item,
    bankName: name,
    bankSnapshot: {
      id: item.bankAccountId || (account && account.id) || '',
      name,
      verticalId,
      verticalName: verticalId ? MasterHelpers.verticalName(masterData, verticalId) : '',
    },
  };
}

function validateUser(user) {
  if (!user || !user.id || !String(user.name || '').trim() || !String(user.username || '').trim()) {
    throw new Error('Every user needs an id, name and email address.');
  }
  if (!Object.values(ROLES).includes(user.role)) throw new Error('The selected user role is invalid.');
  if (typeof user.active !== 'boolean') throw new Error('User active status must be Boolean true or false.');
  return user;
}

function validateTransaction(item) {
  if (!Utils.isValidISODate(item.date) || item.date > Utils.todayISO()) throw new Error('Enter a valid transaction date, no later than today.');
  if (![TXN_TYPE.INFLOW, TXN_TYPE.OUTFLOW, TXN_TYPE.INTERNAL].includes(item.type)) throw new Error('Select a valid transaction type.');
  if (![TXN_STATUS.CATEGORIZED, TXN_STATUS.UNCATEGORIZED, 'void'].includes(item.status)) throw new Error('Invalid transaction status.');
  if (![item.deposit, item.withdrawal].every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) || Utils.netCash(item) === 0) throw new Error('Enter valid non-negative deposit and withdrawal amounts with a non-zero net value.');
  if (item.source === TXN_SOURCE.BANK && !item.bankAccountId) throw new Error('Select a bank account.');
}

const DataStore = {
  clearCache() {
    stopSession();
    _dashboardCheckedAt = 0;
    _verifiedMonths.clear();
    _liveKeys.clear();
    new Set([...Object.keys(_cache), ...Object.keys(_reads), ...Object.keys(_versions)]).forEach((key) => {
      _versions[key] = (_versions[key] || 0) + 1;
      delete _cache[key]; delete _reads[key];
    });
  },
  async watchMetadata(userId, onChange, onError) {
    const session = startSession(userId);
    session.listeners.add(onChange);
    session.errorListeners.add(onError);
    // Deliver values that arrived before this watcher attached.
    metadataWatches(userId).forEach(([key]) => { if (_liveKeys.has(key)) onChange(key, _cache[key]); });
    if (session.error) onError(session.error);
    return () => {
      session.listeners.delete(onChange); session.errorListeners.delete(onError);
      if (_session === session) stopSession();
    };
  },
  async getTransactionPage(options = {}) {
    const bridge = await firebaseBridge();
    const query = transactionQueryOptions(options);
    query.orders = [{ field: 'date', direction: 'desc' }, { field: '__name__', direction: 'desc' }];
    const search = String(options.search || '').trim().toLowerCase();
    const matches = [];
    let after = options.after || null, scanned = 0, hasMore = false;
    do {
      const page = await bridge.listPage('transactions', { ...query, after, limit: 50 });
      for (let i = 0; i < page.rows.length; i++) {
        const row = page.rows[i]; scanned++;
        after = [row.date, row.id];
        if (!search || [row.particulars, row.particulars2, row.remarksBank, row.bankName, row.id].join(' ').toLowerCase().includes(search)) matches.push(row);
        if (matches.length === 50) return { rows: matches, cursor: after, hasMore: i < page.rows.length - 1 || page.hasMore, scanned };
      }
      hasMore = page.hasMore;
      // Long searches stay responsive and explicitly offer continuation.
    } while (hasMore && scanned < 1000);
    return { rows: matches, cursor: after, hasMore, scanned };
  },
  async getTransactionHistory(id) {
    return (await firebaseBridge()).listAll('transactions/' + id + '/history', { orders: [{ field: 'savedAt', direction: 'desc' }] });
  },
  describeError(error, fallback) {
    const code = String(error && error.code || '').toLowerCase();
    const message = String(error && error.message || '');
    if (code.includes('permission-denied') || message.toLowerCase().includes('permission')) {
      return 'Firebase access denied. Verify the user UID/profile and publish the supplied Firestore rules.';
    }
    if (code.includes('failed-precondition') || message.toLowerCase().includes('index')) {
      return 'A required Firestore index is not ready. Deploy firestore.indexes.json and try again.';
    }
    if (code.includes('unavailable') || code.includes('deadline-exceeded')) {
      return 'Firebase is temporarily unavailable. Check the connection and try again.';
    }
    return fallback || message || 'Could not load data.';
  },

  async getUsers() { return cachedGet('users', () => FirebaseBackend.getUsers()); },
  async getUser(id) { startSession(id); return cachedGet('user:' + id, () => FirebaseBackend.getUser(id)); },
  async upsertUser(user) {
    validateUser(user);
    const saved = await FirebaseBackend.upsertUser(user);
    delete _cache.users;
    return saved;
  },
  async deleteUser(id) {
    await FirebaseBackend.deleteUser(id);
    delete _cache.users;
  },

  async getMasterData() { return cachedGet('masterData', () => FirebaseBackend.getMasterData()); },
  async saveMasterData(data) {
    const validation = MasterHelpers.validateMasterData(data);
    if (!validation.valid) throw new Error(validation.errors.slice(0, 5).join(' '));
    return serializedWrite('masterData', async () => {
      const saved = await FirebaseBackend.saveMasterData(data);
      _cache.masterData = saved;
      return saved;
    });
  },

  // Loads everything a report needs for a month range from the local copy, after
  // bringing it up to date. fresh: true also re-checks each month's server totals.
  async getReportData({ fromMonth, toMonth, budgets = false, fresh = false }) {
    const loaded = await withLocal((store, bridge) => exclusiveLocal(async () => {
      let state = await catchUp(store, bridge);
      state = await ensureMonths(store, bridge, state, monthsBetween(fromMonth, toMonth), fresh);
      const [transactions, budgetRows, months] = await Promise.all([
        // Same order as a server query: newest date first, then document id descending.
        store.transactionsForMonths(fromMonth, toMonth).then((rows) => rows.sort((a, b) => b.date.localeCompare(a.date) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0))),
        budgets ? budgetsFor(store, bridge, fromMonth, toMonth) : [],
        availableMonthsFrom(store, state),
      ]);
      return { transactions, budgets: budgetRows, months };
    }), async () => {
      const [transactions, budgetRows, months] = await Promise.all([
        FirebaseBackend.getTransactions(`${fromMonth}-01`, `${toMonth}-31`),
        budgets ? FirebaseBackend.getBudgets(fromMonth, toMonth) : [],
        FirebaseBackend.getAvailableMonths(),
      ]);
      return { transactions, budgets: budgetRows, months };
    });
    return { ...loaded, loadedAt: Date.now() };
  },
  async bulkUpsertTransactions(items) {
    // Master Data is kept current by a live listener, so no extra read per save.
    const masterData = await DataStore.getMasterData();
    const enriched = (items || []).map((incoming) => {
      validateTransaction(incoming);
      let next = snapshotBank(masterData, incoming);
      if (next.status === TXN_STATUS.CATEGORIZED && !next.categorySnapshot) {
        const selection = MasterHelpers.validateSelection(masterData, next, next.type);
        if (!selection.valid) throw new Error(selection.error);
        next = snapshotSelection(masterData, next);
      }
      return next;
    });
    return afterWrite(FirebaseBackend.upsertTransactions(enriched));
  },
  async importTransactions(items, options = {}) {
    const md = await DataStore.getMasterData();
    const rows = (items || []).map((item) => {
      validateTransaction(item);
      let next = snapshotBank(md, item);
      if (next.status === TXN_STATUS.CATEGORIZED) {
        const validation = MasterHelpers.validateSelection(md, next, next.type);
        if (!validation.valid) throw new Error('Master Data changed. Reload the file preview before importing.');
        next = { ...next, categorySnapshot: validation.snapshot };
      }
      return normalizeTransaction(next);
    });
    return afterWrite((await firebaseBridge()).importTransactions(rows, Boolean(options.allowDuplicates)));
  },
  // Budget rows are reused only while each month's lock revision is unchanged, so
  // the Budget page always edits exactly the current rows.
  async getBudgets(fromMonth, toMonth) {
    return withLocal((store, bridge) => budgetsFor(store, bridge, fromMonth, toMonth), () => FirebaseBackend.getBudgets(fromMonth, toMonth));
  },
  async replaceBudgetsForMonth(month, items, expectedRevisions) {
    const bridge = await firebaseBridge();
    return saveBudgetMonth(month, (known) => bridge.saveBudgets(month, items, expectedRevisions, [], true, known));
  },
  async patchBudgetsForMonth(month, subHeadIds, items, expectedRevisions) {
    const bridge = await firebaseBridge();
    return saveBudgetMonth(month, (known) => bridge.saveBudgets(month, items, expectedRevisions, subHeadIds, false, known));
  },

  async getSettings() {
    const stored = await cachedGet('settings', () => FirebaseBackend.getSettings());
    return stored || { ...DEFAULT_SETTINGS };
  },
  async saveSettings(settings) {
    return serializedWrite('settings', async () => {
      const saved = await FirebaseBackend.saveSettings(settings);
      _cache.settings = saved;
      return saved;
    });
  },

  async getMappingMemory() { return cachedGet('mappingMemory', () => FirebaseBackend.getMappingMemory()); },
  async rememberMappings(items) {
    const masterData = await DataStore.getMasterData();
    const valid = (items || []).filter((item) => Utils.mappingMemoryKey(item.remark)
      && MasterHelpers.validateSelection(masterData, item.mapping, item.mapping && item.mapping.type).valid);
    if (!valid.length) return DataStore.getMappingMemory();
    return serializedWrite('mappingMemory', async () => {
      const saved = await (await firebaseBridge()).rememberMappings(valid.map((item) => ({ key: Utils.mappingMemoryKey(item.remark), mapping: item.mapping })), MAPPING_MEMORY_MAX_ENTRIES);
      _cache.mappingMemory = saved;
      return saved;
    });
  },
  async pruneMappingMemory(masterData) {
    const clean = await (await firebaseBridge()).pruneMappings((mapping) => MasterHelpers.validateSelection(masterData, mapping, mapping?.type).valid);
    _cache.mappingMemory = clean;
    return clean;
  },

  async getAvailableMonths() {
    return withLocal((store, bridge) => exclusiveLocal(async () => availableMonthsFrom(store, await catchUp(store, bridge))),
      () => FirebaseBackend.getAvailableMonths());
  },
  // The last dashboard is kept locally and reused while no transaction has been
  // saved since it was computed and bank balance reviews are unchanged.
  async getDashboardData(masterData, options = {}) {
    const month = Utils.monthKey(Utils.todayISO());
    const bankIds = (masterData.bankAccounts || []).map((item) => item.id);
    const key = `${month}|${bankIds.join(',')}`;
    const compute = async (bridge) => ({ ...(await bridge.dashboard(month, bankIds)) });
    const value = await withLocal(async (store, bridge) => {
      const cached = await store.getMeta('dashboard');
      if (!options.fresh && cached && cached.key === key) {
        if (Date.now() - _dashboardCheckedAt < DASHBOARD_RECHECK_MS) return cached.value;
        const [changed, selections] = await Promise.all([bridge.hasChangesSince(cached.cursor), bankIds.length ? bridge.balanceSelections() : []]);
        if (!changed && selectionsKey(selections) === selectionsKey(cached.value.selections)) {
          _dashboardCheckedAt = Date.now();
          return cached.value;
        }
      }
      const cursor = await bridge.latestChange();
      const fresh = toStorable(await compute(bridge));
      await store.setMeta('dashboard', { key, cursor, value: fresh });
      _dashboardCheckedAt = Date.now();
      return fresh;
    }, async () => compute(await firebaseBridge()));
    return { ...value, loadedAt: Date.now() };
  },
  async confirmBankBalance(bankId, transactionId, date) { return afterWrite((await firebaseBridge()).confirmBankBalance(bankId, transactionId, date)); },
  async reconcileBudgetDuplicates(month, subHeadId, keepId, expectedKey) { return afterWrite((await firebaseBridge()).reconcileBudgetDuplicates(month, subHeadId, keepId, expectedKey)); },
};
