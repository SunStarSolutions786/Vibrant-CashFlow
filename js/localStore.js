// ============================================================================
// VIBRANT CashFlow — local copy of report data in this browser.
// Transactions, verified budget months and the last dashboard are kept in
// IndexedDB so revisiting a report only asks Firebase for what changed.
// Falls back to memory when IndexedDB is unavailable (e.g. private browsing).
// ============================================================================

const LOCAL_STORE_SCHEMA = 1;

function createMemoryLocalStore() {
  const rows = new Map();
  const meta = new Map();
  const copy = (value) => (value === undefined ? undefined : structuredClone(value));
  return {
    async getMeta(key) { return copy(meta.get(key)); },
    async setMeta(key, value) { meta.set(key, copy(value)); },
    async putTransactions(list) { list.forEach((row) => rows.set(row.id, copy(row))); },
    async replaceMonths(months, list) {
      const wanted = new Set(months);
      for (const [id, row] of rows) if (wanted.has(row.month)) rows.delete(id);
      list.forEach((row) => rows.set(row.id, copy(row)));
    },
    async transactionsForMonths(fromMonth, toMonth) {
      return Array.from(rows.values()).filter((row) => row.month >= fromMonth && row.month <= toMonth).map(copy);
    },
    async clearTransactions() { rows.clear(); },
  };
}

function openIndexedDbLocalStore(indexedDB, name) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, LOCAL_STORE_SCHEMA);
    request.onupgradeneeded = () => {
      const db = request.result;
      Array.from(db.objectStoreNames).forEach((store) => db.deleteObjectStore(store));
      db.createObjectStore('transactions', { keyPath: 'id' }).createIndex('month', 'month');
      db.createObjectStore('meta');
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('Local data store is blocked by another tab.'));
    request.onsuccess = () => {
      const db = request.result;
      // Another tab upgrading the schema must not be blocked by this one.
      db.onversionchange = () => db.close();
      const run = (stores, mode, work) => new Promise((done, fail) => {
        const tx = db.transaction(stores, mode);
        let result;
        tx.oncomplete = () => done(result);
        tx.onerror = () => fail(tx.error);
        tx.onabort = () => fail(tx.error || new Error('Local data write was aborted.'));
        result = work(tx);
      });
      const requestValue = (req) => new Promise((done, fail) => { req.onsuccess = () => done(req.result); req.onerror = () => fail(req.error); });
      resolve({
        async getMeta(key) {
          const tx = db.transaction('meta', 'readonly');
          return requestValue(tx.objectStore('meta').get(key));
        },
        setMeta: (key, value) => run('meta', 'readwrite', (tx) => { tx.objectStore('meta').put(value, key); }),
        putTransactions: (list) => run('transactions', 'readwrite', (tx) => {
          const store = tx.objectStore('transactions');
          list.forEach((row) => store.put(row));
        }),
        replaceMonths: (months, list) => run('transactions', 'readwrite', (tx) => {
          const store = tx.objectStore('transactions');
          const keep = new Set(list.map((row) => row.id));
          const write = () => list.forEach((row) => store.put(row));
          let pending = months.length;
          if (!pending) { write(); return; }
          months.forEach((month) => {
            store.index('month').getAllKeys(month).onsuccess = (event) => {
              event.target.result.forEach((key) => { if (!keep.has(key)) store.delete(key); });
              if (--pending === 0) write();
            };
          });
        }),
        async transactionsForMonths(fromMonth, toMonth) {
          const tx = db.transaction('transactions', 'readonly');
          return requestValue(tx.objectStore('transactions').index('month').getAll(IDBKeyRange.bound(fromMonth, toMonth)));
        },
        clearTransactions: () => run('transactions', 'readwrite', (tx) => { tx.objectStore('transactions').clear(); }),
      });
    };
  });
}

async function openLocalStore(scope) {
  if (window.VCF_LOCAL_STORE) return window.VCF_LOCAL_STORE;
  if (!window.indexedDB) return createMemoryLocalStore();
  try {
    return await openIndexedDbLocalStore(window.indexedDB, 'vcf-local-' + (scope || 'default'));
  } catch (error) {
    console.warn('Local data store unavailable; using memory for this session.', error);
    return createMemoryLocalStore();
  }
}
