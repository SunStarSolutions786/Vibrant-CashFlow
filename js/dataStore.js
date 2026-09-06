// ============================================================================
// VIBRANT CashFlow — async storage abstraction (localStorage in test mode).
// Writes are serialized per entity and the cache is updated only after the
// backend write succeeds. This prevents overlapping UI saves from publishing
// phantom cache state and substantially reduces same-tab lost updates.
// ============================================================================

const STORAGE_PREFIX = 'vcf_';

function readKey(key, fallback) {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) {
    console.error('DataStore read error', key, e);
    throw new Error(`Stored ${key} data is unreadable. Export or clear the damaged browser storage before continuing.`);
  }
}

function writeKey(key, value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error(`The ${key} value cannot be stored.`);
  localStorage.setItem(STORAGE_PREFIX + key, serialized);
  return JSON.parse(serialized);
}

function requireArray(value, key) {
  if (!Array.isArray(value)) throw new Error(`Stored ${key} data has an invalid shape.`);
  return value;
}

function requireRecordArray(value, key) {
  const list = requireArray(value, key);
  if (list.some((item) => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error(`Stored ${key} data contains an invalid row.`);
  }
  return list;
}

function requireObject(value, key) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Stored ${key} data has an invalid shape.`);
  return value;
}

function validateUsersForSave(list) {
  if (!Array.isArray(list)) throw new Error('Users must be a list.');
  const ids = new Set();
  const usernames = new Set();
  list.forEach((user) => {
    if (!user || !user.id || !String(user.username || '').trim()) throw new Error('Every user needs an id and username.');
    const username = String(user.username).trim().toLowerCase();
    if (ids.has(user.id)) throw new Error('Duplicate user id.');
    if (usernames.has(username)) throw new Error('That username is already taken.');
    if (!Object.values(ROLES).includes(user.role)) throw new Error('A user has an invalid role.');
    ids.add(user.id); usernames.add(username);
  });
  if (!list.some((user) => user.active && user.role === ROLES.ADMIN)) {
    throw new Error('At least one active Administrator is required.');
  }
  return list;
}

const TICK = () => new Promise((resolve) => setTimeout(resolve, 30));

const LocalBackend = {
  async hasRecord(key) { await TICK(); return localStorage.getItem(STORAGE_PREFIX + key) !== null; },
  async getUsers() { await TICK(); return requireRecordArray(readKey('users', []), 'users'); },
  async saveUsers(list) { await TICK(); return writeKey('users', list); },

  async getMasterData() {
    await TICK();
    const data = requireObject(readKey('masterData', { verticals: [], heads: [], subHeads: [], bankAccounts: [] }), 'masterData');
    ['verticals', 'heads', 'subHeads', 'bankAccounts'].forEach((key) => requireRecordArray(data[key], `masterData.${key}`));
    return data;
  },
  async saveMasterData(data) { await TICK(); return writeKey('masterData', data); },

  async getTransactions() { await TICK(); return requireRecordArray(readKey('transactions', []), 'transactions'); },
  async saveTransactions(list) { await TICK(); return writeKey('transactions', list); },

  async getBudgets() { await TICK(); return requireRecordArray(readKey('budgets', []), 'budgets'); },
  async saveBudgets(list) { await TICK(); return writeKey('budgets', list); },

  async getSettings() { await TICK(); const value = readKey('settings', null); return value == null ? null : requireObject(value, 'settings'); },
  async saveSettings(settings) { await TICK(); return writeKey('settings', settings); },

  async getMappingMemory() { await TICK(); return requireObject(readKey('mappingMemory', {}), 'mappingMemory'); },
  async saveMappingMemory(map) { await TICK(); return writeKey('mappingMemory', map); },
};

async function firebaseBridge() {
  const bridge = await window.VCF_FIREBASE_READY;
  if (!bridge) throw new Error('Firebase is not available in local test mode.');
  return bridge;
}

function firebaseTransactionOptions(options = {}) {
  const filters = [];
  if (options.status) filters.push({ field: 'status', value: options.status });
  if (options.type) filters.push({ field: 'type', value: options.type });
  if (options.source) filters.push({ field: 'source', value: options.source });
  if (options.month) filters.push({ field: 'month', value: options.month });
  if (options.fromDate) filters.push({ field: 'date', op: '>=', value: options.fromDate });
  if (options.toDate) filters.push({ field: 'date', op: '<=', value: options.toDate });
  return {
    filters,
    orders: [{ field: options.orderField || 'date', direction: options.direction || 'desc' }],
    limit: options.all ? undefined : Math.max(1, Number(options.limit) || FIREBASE_QUERY_PAGE_SIZE),
    pageSize: FIREBASE_EXPORT_PAGE_SIZE,
    maxRows: FIREBASE_EXPORT_MAX_ROWS,
  };
}

function normalizeFirebaseTransaction(item) {
  const closing = item && item.closingBalance;
  return {
    ...item,
    month: Utils.monthKey(item && item.date),
    hasClosingBalance: closing !== '' && closing != null && Number.isFinite(Number(closing)),
  };
}

const FirebaseBackend = {
  async hasRecord(key) {
    const bridge = await firebaseBridge();
    if (key === 'users') return (await bridge.list('users', { limit: 1 })).length > 0;
    return Boolean(await bridge.getOne('appData', key, null));
  },
  async getUsers() { return (await firebaseBridge()).list('users', { orders: [{ field: 'name', direction: 'asc' }], limit: 200 }); },
  async getUser(id) { return (await firebaseBridge()).getOne('users', id, null); },
  async saveUsers(list) { await (await firebaseBridge()).putMany('users', list, { merge: false }); return list; },
  async upsertUser(user) { return (await firebaseBridge()).setOne('users', user.id, user, false); },
  async deleteUser(id) { await (await firebaseBridge()).deleteOne('users', id); },

  async getMasterData() {
    return (await firebaseBridge()).getOne('appData', 'masterData', { verticals: [], heads: [], subHeads: [], bankAccounts: [], _revision: 0 });
  },
  async saveMasterData(data) { return (await firebaseBridge()).setOne('appData', 'masterData', data, false); },

  async getTransactions(options = {}) {
    const bridge = await firebaseBridge();
    const queryOptions = firebaseTransactionOptions(options);
    return options.all ? bridge.listAll('transactions', queryOptions) : bridge.list('transactions', queryOptions);
  },
  async saveTransactions(list) { return (await firebaseBridge()).putMany('transactions', list.map(normalizeFirebaseTransaction), { merge: false }); },
  async bulkUpsertTransactions(list) { return (await firebaseBridge()).upsertTransactions(list.map(normalizeFirebaseTransaction)); },
  async deleteTransaction(id) { await (await firebaseBridge()).deleteOne('transactions', id); },
  async existingImportHashes(hashes) { return (await firebaseBridge()).existingImportHashes(hashes); },
  async dashboard(month, bankIds) { return (await firebaseBridge()).dashboard(month, bankIds); },

  async getBudgets(options = {}) {
    const filters = [];
    if (options.month) filters.push({ field: 'month', value: options.month });
    if (options.fromMonth) filters.push({ field: 'month', op: '>=', value: options.fromMonth });
    if (options.toMonth) filters.push({ field: 'month', op: '<=', value: options.toMonth });
    const queryOptions = {
      filters, orders: [{ field: 'month', direction: 'desc' }],
      limit: options.all ? undefined : Math.max(1, Number(options.limit) || FIREBASE_QUERY_PAGE_SIZE),
      pageSize: FIREBASE_EXPORT_PAGE_SIZE, maxRows: FIREBASE_EXPORT_MAX_ROWS,
    };
    const bridge = await firebaseBridge();
    return options.all ? bridge.listAll('budgets', queryOptions) : bridge.list('budgets', queryOptions);
  },
  async saveBudgets(list) { return (await firebaseBridge()).putMany('budgets', list, { merge: false }); },
  async upsertBudgets(list) { return (await firebaseBridge()).putMany('budgets', list, { merge: false }); },
  async deleteBudgets(ids) { return (await firebaseBridge()).deleteMany('budgets', ids); },

  async getSettings() { return (await firebaseBridge()).getOne('appData', 'settings', null); },
  async saveSettings(settings) { return (await firebaseBridge()).setOne('appData', 'settings', settings, false); },
  async getMappingMemory() { return (await firebaseBridge()).getOne('appData', 'mappingMemory', {}); },
  async saveMappingMemory(map) { return (await firebaseBridge()).setOne('appData', 'mappingMemory', map, false); },
  async getAvailableMonths() {
    const rows = await (await firebaseBridge()).list('dataMonths', { orders: [{ field: 'month', direction: 'desc' }], limit: 600 });
    return rows.map((item) => item.month).filter(Boolean);
  },
};

const Backend = USE_FIREBASE ? FirebaseBackend : LocalBackend;
const _cache = Object.create(null);
const _reads = Object.create(null);
const _writeQueues = Object.create(null);
const _versions = Object.create(null);

async function cachedGet(key, fetcher) {
  // A read begun during a save must see the saved value, not the old cache.
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
  const operation = before.catch(() => {}).then(() => {
    _versions[key] = (_versions[key] || 0) + 1;
    delete _cache[key];
    if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
      return navigator.locks.request(`${STORAGE_PREFIX}${key}`, { mode: 'exclusive' }, writer);
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

async function persistValue(key, saver, value) {
  return serializedWrite(key, async () => {
    const saved = await saver(value);
    _cache[key] = saved;
    return saved;
  });
}

function snapshotSelection(md, item) {
  if (!item || item.categorySnapshot) return item;
  let snapshot = MasterHelpers.snapshotForSelection(md, item);
  if (!snapshot && item.subHeadId) {
    const chain = MasterHelpers.resolveChain(md, item.subHeadId);
    snapshot = MasterHelpers.snapshotForSelection(md, chain);
  }
  return snapshot ? { ...item, categorySnapshot: snapshot } : item;
}

function snapshotBank(md, item) {
  if (!item || item.bankSnapshot || (!item.bankAccountId && !item.bankName)) return item;
  const account = (md.bankAccounts || []).find((entry) => entry.id === item.bankAccountId);
  const savedName = item.bankName || (account && account.name) || '';
  if (!savedName) return item;
  const verticalId = (account && account.verticalId) || '';
  return {
    ...item,
    bankName: savedName,
    bankSnapshot: {
      id: item.bankAccountId || (account && account.id) || '',
      name: savedName,
      verticalId,
      verticalName: verticalId ? MasterHelpers.verticalName(md, verticalId) : '',
    },
  };
}

async function rebuildImportMetadata(list, isTarget, canonicalOf, prefix, hashOf, version = 3) {
  const occurrenceByRow = new Map();
  const groupKeyPromises = new Map();
  const targets = [];
  list.forEach((item, index) => {
    if (!isTarget(item)) return;
    const canonical = canonicalOf(item);
    if (!canonical) return;
    const occurrence = (occurrenceByRow.get(canonical) || 0) + 1;
    occurrenceByRow.set(canonical, occurrence);
    if (!groupKeyPromises.has(canonical)) groupKeyPromises.set(canonical, Utils.importGroupKey(prefix, canonical));
    targets.push({ index, canonical, occurrence });
  });
  if (targets.length === 0) return { items: list, changed: false };

  const metadata = new Map(await Promise.all(targets.map(async (target) => [target.index, {
    importHash: await hashOf(target.canonical, target.occurrence),
    importGroupKey: await groupKeyPromises.get(target.canonical),
    importOccurrence: target.occurrence,
  }])));
  let changed = false;
  const items = list.map((item, index) => {
    const nextMeta = metadata.get(index);
    if (!nextMeta || (item.importHash === nextMeta.importHash
      && item.importGroupKey === nextMeta.importGroupKey
      && item.importOccurrence === nextMeta.importOccurrence
      && item.importHashVersion === version)) return item;
    changed = true;
    const updated = { ...item, ...nextMeta, importHashVersion: version };
    if (!updated.legacyImportHash && item.importHash && item.importHash !== nextMeta.importHash) {
      updated.legacyImportHash = item.importHash;
    }
    return updated;
  });
  return { items, changed };
}

const DataStore = {
  async hasStoredRecord(key) {
    if (typeof Backend.hasRecord === 'function') return Backend.hasRecord(key);
    return false;
  },
  // ---- Users ----
  async getUsers() { return cachedGet('users', () => Backend.getUsers()); },
  async getUser(id) {
    if (USE_FIREBASE && typeof Backend.getUser === 'function') return Backend.getUser(id);
    return (await DataStore.getUsers()).find((user) => user.id === id) || null;
  },
  async saveUsers(list) { return persistValue('users', (value) => Backend.saveUsers(value), validateUsersForSave(list)); },
  async initializeUsers(list) {
    const initial = validateUsersForSave(list);
    return serializedWrite('users', async () => {
      const exists = typeof Backend.hasRecord === 'function' && await Backend.hasRecord('users');
      if (exists) {
        const existing = await Backend.getUsers();
        // A stored empty list is an invalid legacy state and is safely repaired;
        // a non-empty account list always wins over seed data.
        if (existing.length > 0) {
          _cache.users = existing;
          return existing;
        }
      }
      const saved = await Backend.saveUsers(initial);
      _cache.users = saved;
      return saved;
    });
  },
  async upsertUser(user) {
    if (USE_FIREBASE) {
      const saved = await Backend.upsertUser(user);
      delete _cache.users;
      return saved;
    }
    return serializedWrite('users', async () => {
      const list = (await Backend.getUsers()).slice();
      const idx = list.findIndex((entry) => entry.id === user.id);
      if (idx >= 0) list[idx] = user; else list.push(user);
      const saved = await Backend.saveUsers(validateUsersForSave(list));
      _cache.users = saved;
      return saved;
    });
  },
  async deleteUser(id) {
    if (USE_FIREBASE) {
      await Backend.deleteUser(id);
      delete _cache.users;
      return [];
    }
    return serializedWrite('users', async () => {
      const list = (await Backend.getUsers()).filter((entry) => entry.id !== id);
      const saved = await Backend.saveUsers(validateUsersForSave(list));
      _cache.users = saved;
      return saved;
    });
  },

  // ---- Master data ----
  async getMasterData() { return cachedGet('masterData', () => Backend.getMasterData()); },
  async saveMasterData(data) {
    const validation = MasterHelpers.validateMasterData(data);
    if (!validation.valid) throw new Error(validation.errors.slice(0, 5).join(' '));
    return serializedWrite('masterData', async () => {
      const current = await Backend.getMasterData();
      const currentRevision = Number(current && current._revision) || 0;
      const expectedRevision = Number(data && data._revision) || 0;
      if (expectedRevision !== currentRevision) {
        throw new Error('Master Data changed in another tab. Reload this page and apply your change again.');
      }
      const saved = await Backend.saveMasterData({ ...data, _revision: currentRevision + 1 });
      _cache.masterData = saved;
      return saved;
    });
  },
  async initializeMasterData(data) {
    const validation = MasterHelpers.validateMasterData(data);
    if (!validation.valid) throw new Error(validation.errors.slice(0, 5).join(' '));
    return serializedWrite('masterData', async () => {
      if (typeof Backend.hasRecord === 'function' && await Backend.hasRecord('masterData')) {
        const existing = await Backend.getMasterData();
        _cache.masterData = existing;
        return existing;
      }
      const saved = await Backend.saveMasterData({ ...data, _revision: 1 });
      _cache.masterData = saved;
      return saved;
    });
  },

  // ---- Transactions ----
  async getTransactions(options) {
    if (USE_FIREBASE) return Backend.getTransactions(options || {});
    const list = await cachedGet('transactions', () => Backend.getTransactions());
    if (!options) return list;
    return list.filter((item) => (!options.status || item.status === options.status)
      && (!options.type || item.type === options.type)
      && (!options.source || item.source === options.source)
      && (!options.month || Utils.monthKey(item.date) === options.month)
      && (!options.fromDate || item.date >= options.fromDate)
      && (!options.toDate || item.date <= options.toDate));
  },
  async saveTransactions(list) {
    const md = await DataStore.getMasterData();
    const enriched = list.map((item) => {
      const banked = snapshotBank(md, item);
      return banked.status === 'categorized' ? snapshotSelection(md, banked) : banked;
    });
    return persistValue('transactions', (value) => Backend.saveTransactions(value), enriched);
  },
  async bulkUpsertTransactions(items) {
    const md = await DataStore.getMasterData();
    if (USE_FIREBASE) {
      const enriched = (items || []).map((incoming) => {
        let next = snapshotBank(md, incoming);
        if (next.status === TXN_STATUS.CATEGORIZED) next = snapshotSelection(md, next);
        return next;
      });
      return Backend.bulkUpsertTransactions(enriched);
    }
    return serializedWrite('transactions', async () => {
      // Re-read persistent state inside the queue so an earlier save/tab is
      // merged instead of being overwritten from an old in-memory list.
      const list = (await Backend.getTransactions()).slice();
      const byId = new Map(list.map((item) => [item.id, item]));
      items.forEach((incoming) => {
        const old = byId.get(incoming.id);
        const hasExpectedRevision = Object.prototype.hasOwnProperty.call(incoming, '_expectedRevision');
        const expectedRevision = hasExpectedRevision ? Number(incoming._expectedRevision) : null;
        const currentRevision = old ? (Number(old._revision) || 0) : null;
        if (hasExpectedRevision && expectedRevision !== currentRevision) {
          throw new Error('A transaction changed in another tab. Reload Categorize and review your changes before saving again.');
        }
        const cleanIncoming = { ...incoming };
        delete cleanIncoming._expectedRevision;
        let next = { ...(old || {}), ...cleanIncoming, _revision: (currentRevision == null ? 0 : currentRevision) + 1 };
        if (!incoming.categorySnapshot && old && old.categorySnapshot) next.categorySnapshot = old.categorySnapshot;
        next = snapshotBank(md, next);
        if (next.status === 'categorized') next = snapshotSelection(md, next);
        byId.set(next.id, next);
      });
      const saved = await Backend.saveTransactions(Array.from(byId.values()));
      _cache.transactions = saved;
      return saved;
    });
  },
  async importTransactions(items, options) {
    const allowDuplicates = Boolean(options && options.allowDuplicates);
    const md = await DataStore.getMasterData();
    if (USE_FIREBASE) {
      const incoming = items || [];
      const existing = await Backend.existingImportHashes(incoming.map((item) => item.importHash));
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
        next = snapshotBank(md, next);
        if (next.status === TXN_STATUS.CATEGORIZED) next = snapshotSelection(md, next);
        accepted.push({ ...next, _revision: 1 });
      });
      if (accepted.length) await Backend.saveTransactions(accepted);
      return { transactions: accepted, inserted: accepted.length, duplicates, acceptedDuplicates };
    }
    return serializedWrite('transactions', async () => {
      const list = (await Backend.getTransactions()).slice();
      const byId = new Map(list.map((item) => [item.id, item]));
      const hashes = new Set(list.map((item) => item.importHash).filter(Boolean));
      const groupCounts = new Map();
      list.forEach((item) => {
        if (item.importGroupKey) groupCounts.set(item.importGroupKey, (groupCounts.get(item.importGroupKey) || 0) + 1);
      });
      const incomingOccurrences = new Map();
      let inserted = 0;
      let duplicates = 0;
      let acceptedDuplicates = 0;
      (items || []).forEach((incoming) => {
        let accepted = { ...incoming };
        const groupKey = incoming.importGroupKey || '';
        const seenInBatch = (incomingOccurrences.get(groupKey) || 0) + 1;
        if (groupKey) incomingOccurrences.set(groupKey, seenInBatch);
        const requestedOccurrence = Number.isInteger(Number(incoming.importOccurrence)) && Number(incoming.importOccurrence) > 0
          ? Number(incoming.importOccurrence)
          : seenInBatch;
        const storedCount = groupKey ? (groupCounts.get(groupKey) || 0) : 0;
        const isDuplicate = Boolean((incoming.importHash && hashes.has(incoming.importHash))
          || (groupKey && requestedOccurrence <= storedCount));
        if (isDuplicate) {
          if (!allowDuplicates) { duplicates++; return; }

          // Keep the original fingerprint for audit/review, while assigning the
          // explicitly accepted copy its own fingerprint. Occurrence counting
          // remains authoritative, so future multi-row imports see this copy.
          const duplicateOfHash = incoming.importHash || groupKey;
          const acceptedHashBase = `${duplicateOfHash}:accepted:${incoming.id || 'transaction'}`;
          let acceptedHash = acceptedHashBase;
          let suffix = 2;
          while (hashes.has(acceptedHash)) acceptedHash = `${acceptedHashBase}:${suffix++}`;
          accepted = {
            ...accepted,
            duplicateOfHash,
            importHash: acceptedHash,
            importOccurrence: groupKey ? storedCount + 1 : requestedOccurrence,
          };
          acceptedDuplicates++;
        } else if (groupKey) {
          accepted.importOccurrence = storedCount + 1;
        }
        let next = snapshotBank(md, accepted);
        if (next.status === 'categorized') next = snapshotSelection(md, next);
        next = { ...next, _revision: Number(next._revision) || 1 };
        byId.set(next.id, next);
        if (next.importHash) hashes.add(next.importHash);
        if (groupKey) groupCounts.set(groupKey, storedCount + 1);
        inserted++;
      });
      const saved = inserted ? await Backend.saveTransactions(Array.from(byId.values())) : list;
      _cache.transactions = saved;
      return { transactions: saved, inserted, duplicates, acceptedDuplicates };
    });
  },
  async backfillStatementImportHashes() {
    return serializedWrite('transactions', async () => {
      const list = await Backend.getTransactions();
      const isTrackedStatement = (item) => item && item.source === TXN_SOURCE.BANK
        && Boolean(item.importBatchId || item.importHash || item.importHashVersion
          || Object.prototype.hasOwnProperty.call(item, 'closingBalance'));
      const tracked = list.filter(isTrackedStatement);
      if (!tracked.some((item) => item.importHashVersion !== 3
        || !String(item.importHash || '').startsWith('statement-v3:')
        || !String(item.importGroupKey || '').startsWith('statement-v3:group:')
        || !Number.isInteger(Number(item.importOccurrence)) || Number(item.importOccurrence) < 1)) {
        _cache.transactions = list;
        return list;
      }
      const rebuilt = await rebuildImportMetadata(list, isTrackedStatement, Utils.canonicalStatementRow,
        'statement-v3', Utils.statementImportHash);
      const saved = rebuilt.changed ? await Backend.saveTransactions(rebuilt.items) : list;
      _cache.transactions = saved;
      return saved;
    });
  },
  async backfillCashImportMetadata() {
    return serializedWrite('transactions', async () => {
      const list = await Backend.getTransactions();
      const isTrackedCash = (item) => item && item.source === TXN_SOURCE.CASH
        && Boolean(item.importHash || item.importHashVersion);
      const tracked = list.filter(isTrackedCash);
      if (!tracked.some((item) => item.importHashVersion !== 4
        || !String(item.importHash || '').startsWith('cash-v4:')
        || !String(item.importGroupKey || '').startsWith('cash-v4:group:')
        || !Number.isInteger(Number(item.importOccurrence)) || Number(item.importOccurrence) < 1)) {
        _cache.transactions = list;
        return list;
      }
      const rebuilt = await rebuildImportMetadata(list, isTrackedCash, Utils.canonicalCashRow,
        'cash-v4', Utils.cashImportHash, 4);
      const saved = rebuilt.changed ? await Backend.saveTransactions(rebuilt.items) : list;
      _cache.transactions = saved;
      return saved;
    });
  },
  async deleteTransaction(id) {
    if (USE_FIREBASE) {
      await Backend.deleteTransaction(id);
      return [];
    }
    return serializedWrite('transactions', async () => {
      const list = (await Backend.getTransactions()).filter((item) => item.id !== id);
      const saved = await Backend.saveTransactions(list);
      _cache.transactions = saved;
      return saved;
    });
  },

  // ---- Budgets ----
  async getBudgets(options) {
    if (USE_FIREBASE) return Backend.getBudgets(options || {});
    const list = await cachedGet('budgets', () => Backend.getBudgets());
    if (!options) return list;
    return list.filter((item) => (!options.month || item.month === options.month)
      && (!options.fromMonth || item.month >= options.fromMonth)
      && (!options.toMonth || item.month <= options.toMonth));
  },
  async saveBudgets(list) {
    const md = await DataStore.getMasterData();
    const enriched = list.map((item) => snapshotSelection(md, item));
    return persistValue('budgets', (value) => Backend.saveBudgets(value), enriched);
  },
  async bulkUpsertBudgets(items) {
    const md = await DataStore.getMasterData();
    if (USE_FIREBASE) {
      const saved = (items || []).map((item) => snapshotSelection(md, item));
      await Backend.upsertBudgets(saved);
      return saved;
    }
    return serializedWrite('budgets', async () => {
      const list = (await Backend.getBudgets()).slice();
      const keyOf = (item) => `${item.month}|${item.subHeadId}`;
      const byKey = new Map(list.map((item) => [keyOf(item), item]));
      items.forEach((incoming) => {
        const key = keyOf(incoming);
        const old = byKey.get(key);
        let next = { ...(old || {}), ...incoming };
        if (!incoming.categorySnapshot && old && old.categorySnapshot) next.categorySnapshot = old.categorySnapshot;
        next = snapshotSelection(md, next);
        byKey.set(key, next);
      });
      const saved = await Backend.saveBudgets(Array.from(byKey.values()));
      _cache.budgets = saved;
      return saved;
    });
  },

  // Replaces all rows for one month. Used by "Copy Previous Month" so rows
  // absent from the new draft cannot silently survive the replacement.
  async replaceBudgetsForMonth(month, items, expectedRevisions) {
    const md = await DataStore.getMasterData();
    if (USE_FIREBASE) {
      const current = await Backend.getBudgets({ month, limit: 2000 });
      const currentMap = new Map(current.map((item) => [item.subHeadId, Number(item._revision) || 0]));
      if (expectedRevisions && (currentMap.size !== Object.keys(expectedRevisions).length
        || Object.keys(expectedRevisions).some((id) => currentMap.get(id) !== expectedRevisions[id]))) {
        throw new Error('This month\'s Budget & Booking changed in another tab. Reload and review before saving again.');
      }
      const bySub = new Map(current.map((item) => [item.subHeadId, item]));
      const next = (items || []).map((item) => snapshotSelection(md, {
        ...item, _revision: (Number((bySub.get(item.subHeadId) || {})._revision) || 0) + 1,
      }));
      const keepIds = new Set(next.map((item) => item.id));
      await Backend.deleteBudgets(current.filter((item) => !keepIds.has(item.id)).map((item) => item.id));
      await Backend.upsertBudgets(next);
      return next;
    }
    return serializedWrite('budgets', async () => {
      const all = await Backend.getBudgets();
      const currentMonth = all.filter((item) => item.month === month);
      if (expectedRevisions) {
        const currentMap = new Map(currentMonth.map((item) => [item.subHeadId, Number(item._revision) || 0]));
        const expectedKeys = Object.keys(expectedRevisions);
        if (currentMap.size !== expectedKeys.length || expectedKeys.some((id) => !currentMap.has(id)
          || currentMap.get(id) !== expectedRevisions[id])) {
          throw new Error('This month\'s Budget & Booking changed in another tab. Reload and review before saving again.');
        }
      }
      const keep = all.filter((item) => item.month !== month);
      const currentBySub = new Map(currentMonth.map((item) => [item.subHeadId, item]));
      const next = items.map((item) => {
        const old = currentBySub.get(item.subHeadId);
        return snapshotSelection(md, { ...item, _revision: (old ? (Number(old._revision) || 0) : 0) + 1 });
      });
      const saved = await Backend.saveBudgets(keep.concat(next));
      _cache.budgets = saved;
      return saved;
    });
  },
  async patchBudgetsForMonth(month, subHeadIds, items, expectedRevisions) {
    const md = await DataStore.getMasterData();
    const changed = new Set(subHeadIds || []);
    if (USE_FIREBASE) {
      const current = await Backend.getBudgets({ month, limit: 2000 });
      const bySub = new Map(current.map((item) => [item.subHeadId, item]));
      if (expectedRevisions) {
        for (const id of changed) {
          const old = bySub.get(id);
          const revision = old ? Number(old._revision) || 0 : null;
          if (!Object.prototype.hasOwnProperty.call(expectedRevisions, id) || expectedRevisions[id] !== revision) {
            throw new Error('Budget & Booking changed in another tab. Reload and review before saving again.');
          }
        }
      }
      const next = (items || []).map((item) => snapshotSelection(md, {
        ...item, _revision: (Number((bySub.get(item.subHeadId) || {})._revision) || 0) + 1,
      }));
      const incomingSubs = new Set(next.map((item) => item.subHeadId));
      await Backend.deleteBudgets(current.filter((item) => changed.has(item.subHeadId) && !incomingSubs.has(item.subHeadId)).map((item) => item.id));
      await Backend.upsertBudgets(next);
      return next;
    }
    return serializedWrite('budgets', async () => {
      const all = await Backend.getBudgets();
      const currentBySub = new Map(all.filter((item) => item.month === month).map((item) => [item.subHeadId, item]));
      if (expectedRevisions) {
        for (const subHeadId of changed) {
          const current = currentBySub.get(subHeadId);
          const currentRevision = current ? (Number(current._revision) || 0) : null;
          if (!Object.prototype.hasOwnProperty.call(expectedRevisions, subHeadId)
            || expectedRevisions[subHeadId] !== currentRevision) {
            throw new Error('Budget & Booking changed in another tab. Reload and review before saving again.');
          }
        }
      }
      const keep = all.filter((item) => item.month !== month || !changed.has(item.subHeadId));
      const next = (items || []).map((item) => {
        const old = currentBySub.get(item.subHeadId);
        return snapshotSelection(md, { ...item, _revision: (old ? (Number(old._revision) || 0) : 0) + 1 });
      });
      const saved = await Backend.saveBudgets(keep.concat(next));
      _cache.budgets = saved;
      return saved;
    });
  },

  // One-time compatibility migration for data saved before immutable category
  // snapshots existed. Once copied, future Master Data edits cannot rewrite it.
  async backfillHistoricalSnapshots(enrichCategorySnapshot) {
    const md = await DataStore.getMasterData();
    await serializedWrite('transactions', async () => {
      const list = await Backend.getTransactions();
      let changed = false;
      const next = list.map((item) => {
        let enriched = snapshotBank(md, item);
        if (enriched.status === 'categorized' && !enriched.categorySnapshot) enriched = snapshotSelection(md, enriched);
        if (enriched.categorySnapshot && typeof enrichCategorySnapshot === 'function') {
          const repaired = enrichCategorySnapshot(enriched.categorySnapshot, enriched, 'transaction');
          if (repaired && repaired !== enriched.categorySnapshot) enriched = { ...enriched, categorySnapshot: repaired };
        }
        if (enriched !== item) changed = true;
        return enriched;
      });
      const saved = changed ? await Backend.saveTransactions(next) : list;
      _cache.transactions = saved;
      return saved;
    });
    await serializedWrite('budgets', async () => {
      const list = await Backend.getBudgets();
      let changed = false;
      const next = list.map((item) => {
        let enriched = item.categorySnapshot ? item : snapshotSelection(md, item);
        if (enriched.categorySnapshot && typeof enrichCategorySnapshot === 'function') {
          const repaired = enrichCategorySnapshot(enriched.categorySnapshot, enriched, 'budget');
          if (repaired && repaired !== enriched.categorySnapshot) enriched = { ...enriched, categorySnapshot: repaired };
        }
        if (enriched !== item) changed = true;
        return enriched;
      });
      const saved = changed ? await Backend.saveBudgets(next) : list;
      _cache.budgets = saved;
      return saved;
    });
  },

  // ---- Settings ----
  async getSettings() {
    const settings = await cachedGet('settings', () => Backend.getSettings());
    if (settings) return settings;
    return DataStore.saveSettings({ ...DEFAULT_SETTINGS });
  },
  async saveSettings(settings) { return persistValue('settings', (value) => Backend.saveSettings(value), settings); },

  // ---- Mapping memory ----
  async getMappingMemory() { return cachedGet('mappingMemory', () => Backend.getMappingMemory()); },
  async rememberMapping(remark, mapping) {
    return DataStore.rememberMappings([{ remark, mapping }]);
  },
  async rememberMappings(items) {
    const md = await DataStore.getMasterData();
    const valid = (items || []).filter((item) => item.remark && MasterHelpers.validateSelection(md, item.mapping, item.mapping && item.mapping.type).valid);
    if (valid.length === 0) return DataStore.getMappingMemory();
    return serializedWrite('mappingMemory', async () => {
      const memory = { ...(await Backend.getMappingMemory()) };
      valid.forEach((item) => { memory[item.remark.trim().toLowerCase()] = { ...item.mapping }; });
      const saved = await Backend.saveMappingMemory(memory);
      _cache.mappingMemory = saved;
      return saved;
    });
  },
  async pruneMappingMemory(masterData) {
    const md = masterData || await DataStore.getMasterData();
    return serializedWrite('mappingMemory', async () => {
      const current = await Backend.getMappingMemory();
      const clean = {};
      Object.keys(current || {}).forEach((key) => {
        const mapping = current[key];
        if (MasterHelpers.validateSelection(md, mapping, mapping && mapping.type).valid) clean[key] = mapping;
      });
      if (JSON.stringify(clean) !== JSON.stringify(current || {})) await Backend.saveMappingMemory(clean);
      _cache.mappingMemory = clean;
      return clean;
    });
  },

  async getAvailableMonths() {
    if (USE_FIREBASE) return Backend.getAvailableMonths();
    const [transactions, budgets] = await Promise.all([DataStore.getTransactions(), DataStore.getBudgets()]);
    const months = new Set([Utils.monthKey(Utils.todayISO())]);
    transactions.forEach((item) => { const month = Utils.monthKey(item.date); if (month) months.add(month); });
    budgets.forEach((item) => { if (item.month) months.add(item.month); });
    return Array.from(months).sort().reverse();
  },

  async getDashboardData(masterData) {
    const month = Utils.monthKey(Utils.todayISO());
    if (USE_FIREBASE) return Backend.dashboard(month, (masterData.bankAccounts || []).map((item) => item.id));
    const transactions = await DataStore.getTransactions();
    const categorized = transactions.filter((item) => item.status === TXN_STATUS.CATEGORIZED);
    const monthRows = categorized.filter((item) => Utils.monthKey(item.date) === month);
    return {
      totalInflow: Utils.sumBy(categorized.filter((item) => item.type === TXN_TYPE.INFLOW), Utils.netCash),
      totalOutflow: Utils.sumBy(categorized.filter((item) => item.type === TXN_TYPE.OUTFLOW), Utils.netOutflow),
      monthInflow: Utils.sumBy(monthRows.filter((item) => item.type === TXN_TYPE.INFLOW), Utils.netCash),
      monthOutflow: Utils.sumBy(monthRows.filter((item) => item.type === TXN_TYPE.OUTFLOW), Utils.netOutflow),
      uncategorized: transactions.filter((item) => item.status === TXN_STATUS.UNCATEGORIZED).length,
      recent: transactions.slice().sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '')).slice(0, 8),
      latestBalances: latestBankBalanceRows(transactions),
    };
  },

  clearCache() {
    const keys = new Set([...Object.keys(_cache), ...Object.keys(_reads)]);
    keys.forEach((key) => { _versions[key] = (_versions[key] || 0) + 1; });
    Object.keys(_cache).forEach((key) => delete _cache[key]);
    Object.keys(_reads).forEach((key) => delete _reads[key]);
  },
};

// localStorage events fire in the *other* tab. Drop only the affected cache
// entry so the next page read sees that tab's successful write.
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('storage', (event) => {
    if (!event.key || !event.key.startsWith(STORAGE_PREFIX)) return;
    const key = event.key.slice(STORAGE_PREFIX.length);
    _versions[key] = (_versions[key] || 0) + 1;
    delete _cache[key];
    delete _reads[key];
  });
}
