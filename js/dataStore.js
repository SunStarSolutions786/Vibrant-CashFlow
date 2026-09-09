// ============================================================================
// VIBRANT CashFlow — production Firebase data layer.
// Collections containing large data are never globally cached or rewritten.
// Each screen requests only its own date/status range.
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
  if (options.type) filters.push({ field: 'type', value: options.type });
  if (options.source) filters.push({ field: 'source', value: options.source });
  if (options.fromDate) filters.push({ field: 'date', op: '>=', value: options.fromDate });
  if (options.toDate) filters.push({ field: 'date', op: '<=', value: options.toDate });
  return {
    filters,
    orders: options.ordered === false ? [] : [{ field: options.orderField || 'date', direction: options.direction || 'desc' }],
    limit: options.all ? undefined : Math.max(1, Number(options.limit) || FIREBASE_QUERY_PAGE_SIZE),
    pageSize: FIREBASE_EXPORT_PAGE_SIZE,
    maxRows: FIREBASE_EXPORT_MAX_ROWS,
  };
}

function normalizeTransaction(item) {
  const closing = item && item.closingBalance;
  const categorized = item && item.status === TXN_STATUS.CATEGORIZED;
  return {
    ...item,
    month: Utils.monthKey(item && item.date),
    hasClosingBalance: closing !== '' && closing != null && Number.isFinite(Number(closing)),
    inflowNet: categorized && item.type === TXN_TYPE.INFLOW ? Utils.netCash(item) : 0,
    outflowNet: categorized && item.type === TXN_TYPE.OUTFLOW ? Utils.netOutflow(item) : 0,
  };
}

const FirebaseBackend = {
  async getUsers() {
    return (await firebaseBridge()).list('users', {
      orders: [{ field: 'name', direction: 'asc' }], limit: 200,
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

  async getTransactions(options = {}) {
    const bridge = await firebaseBridge();
    const queryOptions = transactionQueryOptions(options);
    return options.all
      ? bridge.listAll('transactions', queryOptions)
      : bridge.list('transactions', queryOptions);
  },
  async insertTransactions(list) {
    const rows = (list || []).map(normalizeTransaction);
    await (await firebaseBridge()).putMany('transactions', rows, { merge: false });
    return rows;
  },
  async upsertTransactions(list) {
    return (await firebaseBridge()).upsertTransactions((list || []).map(normalizeTransaction));
  },
  async existingImportHashes(hashes) { return (await firebaseBridge()).existingImportHashes(hashes); },
  async dashboard(month, bankIds) { return (await firebaseBridge()).dashboard(month, bankIds); },

  async getBudgets(options = {}) {
    const filters = [];
    if (options.month) filters.push({ field: 'month', value: options.month });
    if (options.fromMonth) filters.push({ field: 'month', op: '>=', value: options.fromMonth });
    if (options.toMonth) filters.push({ field: 'month', op: '<=', value: options.toMonth });
    const queryOptions = {
      filters,
      orders: options.fromMonth || options.toMonth
        ? [{ field: 'month', direction: 'desc' }]
        : (options.month ? [] : [{ field: 'month', direction: 'desc' }]),
      limit: options.all ? undefined : Math.max(1, Number(options.limit) || FIREBASE_QUERY_PAGE_SIZE),
      pageSize: FIREBASE_EXPORT_PAGE_SIZE,
      maxRows: FIREBASE_EXPORT_MAX_ROWS,
    };
    const bridge = await firebaseBridge();
    return options.all ? bridge.listAll('budgets', queryOptions) : bridge.list('budgets', queryOptions);
  },
  async upsertBudgets(list) { return (await firebaseBridge()).putMany('budgets', list, { merge: false }); },
  async deleteBudgets(ids) { return (await firebaseBridge()).deleteMany('budgets', ids); },

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
    // Read the original key-per-field format once, then migrate it on the next save.
    return raw;
  },
  async saveMappingMemory(memory) {
    const entries = Object.entries(memory || {}).map(([key, mapping]) => ({
      key: Utils.mappingMemoryKey(key), mapping,
    })).filter((item) => item.key);
    await (await firebaseBridge()).setOne('appData', 'mappingMemory', { entries }, false);
    return memory || {};
  },
  async getAvailableMonths() {
    const rows = await (await firebaseBridge()).list('dataMonths', {
      orders: [{ field: 'month', direction: 'desc' }], limit: 600,
    });
    return rows.map((item) => item.month).filter(Boolean);
  },
};

const _cache = Object.create(null);
const _reads = Object.create(null);
const _writeQueues = Object.create(null);
const _versions = Object.create(null);

async function cachedGet(key, fetcher) {
  if (_writeQueues[key]) await _writeQueues[key].catch(() => {});
  if (Object.prototype.hasOwnProperty.call(_cache, key)) return _cache[key];
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

const DataStore = {
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
  async getUser(id) { return FirebaseBackend.getUser(id); },
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

  async getTransactions(options = {}) { return FirebaseBackend.getTransactions(options); },
  async bulkUpsertTransactions(items) {
    const masterData = await DataStore.getMasterData();
    const enriched = (items || []).map((incoming) => {
      let next = snapshotBank(masterData, incoming);
      if (next.status === TXN_STATUS.CATEGORIZED) next = snapshotSelection(masterData, next);
      return next;
    });
    return FirebaseBackend.upsertTransactions(enriched);
  },
  async importTransactions(items, options) {
    const allowDuplicates = Boolean(options && options.allowDuplicates);
    const masterData = await DataStore.getMasterData();
    const incoming = items || [];
    const existing = await FirebaseBackend.existingImportHashes(incoming.map((item) => item.importHash));
    const accepted = [];
    const seen = new Set(existing);
    let duplicates = 0;
    let acceptedDuplicates = 0;
    incoming.forEach((item) => {
      let next = { ...item };
      if (next.importHash && seen.has(next.importHash)) {
        if (!allowDuplicates) { duplicates++; return; }
        next.duplicateOfHash = next.importHash;
        next.importHash = `${next.importHash}:accepted:${next.id}`;
        acceptedDuplicates++;
      }
      if (next.importHash) seen.add(next.importHash);
      next = snapshotBank(masterData, next);
      if (next.status === TXN_STATUS.CATEGORIZED) next = snapshotSelection(masterData, next);
      accepted.push({ ...next, _revision: 1 });
    });
    if (accepted.length) await FirebaseBackend.insertTransactions(accepted);
    return { transactions: accepted, inserted: accepted.length, duplicates, acceptedDuplicates };
  },
  async getBudgets(options = {}) { return FirebaseBackend.getBudgets(options); },
  async replaceBudgetsForMonth(month, items, expectedRevisions) {
    const masterData = await DataStore.getMasterData();
    return serializedWrite(`budgets_${month}`, async () => {
      const current = await FirebaseBackend.getBudgets({ month, all: true });
      const revisions = new Map(current.map((item) => [item.subHeadId, Number(item._revision) || 0]));
      if (expectedRevisions && (revisions.size !== Object.keys(expectedRevisions).length
        || Object.keys(expectedRevisions).some((id) => revisions.get(id) !== expectedRevisions[id]))) {
        throw new Error('This month\'s Budget & Booking changed elsewhere. Reload and review before saving again.');
      }
      const bySubHead = new Map(current.map((item) => [item.subHeadId, item]));
      const next = (items || []).map((item) => snapshotSelection(masterData, {
        ...item,
        _revision: (Number((bySubHead.get(item.subHeadId) || {})._revision) || 0) + 1,
      }));
      const keepIds = new Set(next.map((item) => item.id));
      await FirebaseBackend.deleteBudgets(current.filter((item) => !keepIds.has(item.id)).map((item) => item.id));
      await FirebaseBackend.upsertBudgets(next);
      return next;
    });
  },
  async patchBudgetsForMonth(month, subHeadIds, items, expectedRevisions) {
    const masterData = await DataStore.getMasterData();
    const changed = new Set(subHeadIds || []);
    return serializedWrite(`budgets_${month}`, async () => {
      const current = await FirebaseBackend.getBudgets({ month, all: true });
      const bySubHead = new Map(current.map((item) => [item.subHeadId, item]));
      if (expectedRevisions) {
        for (const id of changed) {
          const old = bySubHead.get(id);
          const revision = old ? Number(old._revision) || 0 : null;
          if (!Object.prototype.hasOwnProperty.call(expectedRevisions, id) || expectedRevisions[id] !== revision) {
            throw new Error('Budget & Booking changed elsewhere. Reload and review before saving again.');
          }
        }
      }
      const next = (items || []).map((item) => snapshotSelection(masterData, {
        ...item,
        _revision: (Number((bySubHead.get(item.subHeadId) || {})._revision) || 0) + 1,
      }));
      const savedSubHeads = new Set(next.map((item) => item.subHeadId));
      await FirebaseBackend.deleteBudgets(current
        .filter((item) => changed.has(item.subHeadId) && !savedSubHeads.has(item.subHeadId))
        .map((item) => item.id));
      await FirebaseBackend.upsertBudgets(next);
      return next;
    });
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
      const memory = new Map(Object.entries(await FirebaseBackend.getMappingMemory()));
      const savedAt = new Date().toISOString();
      valid.forEach((item) => { memory.set(Utils.mappingMemoryKey(item.remark), { ...item.mapping, _savedAt: savedAt }); });
      const bounded = Object.fromEntries(Array.from(memory.entries())
        .sort((a, b) => String(a[1] && a[1]._savedAt || '').localeCompare(String(b[1] && b[1]._savedAt || '')))
        .slice(-MAPPING_MEMORY_MAX_ENTRIES));
      const saved = await FirebaseBackend.saveMappingMemory(bounded);
      _cache.mappingMemory = saved;
      return saved;
    });
  },
  async pruneMappingMemory(masterData) {
    const source = await FirebaseBackend.getMappingMemory();
    const clean = {};
    Object.keys(source || {}).forEach((key) => {
      const mapping = source[key];
      if (MasterHelpers.validateSelection(masterData, mapping, mapping && mapping.type).valid) {
        clean[Utils.mappingMemoryKey(key)] = mapping;
      }
    });
    if (JSON.stringify(clean) !== JSON.stringify(source || {})) await FirebaseBackend.saveMappingMemory(clean);
    _cache.mappingMemory = clean;
    return clean;
  },

  async getAvailableMonths() { return FirebaseBackend.getAvailableMonths(); },
  async getDashboardData(masterData) {
    return FirebaseBackend.dashboard(
      Utils.monthKey(Utils.todayISO()),
      (masterData.bankAccounts || []).map((item) => item.id),
    );
  },
};
