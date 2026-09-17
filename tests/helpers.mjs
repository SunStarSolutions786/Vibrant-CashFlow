import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';

export function loadApplication(bridge = {}, windowObject = {}) {
  const source = ['config', 'utils', 'masterHelpers', 'firebaseRepository', 'userProvisioning', 'localStore', 'dataStore', 'auth']
    .map((file) => readFileSync(`js/${file}.js`, 'utf8')).join('\n');
  // Use this realm's plain objects: Firebase rejects cross-vm prototypes.
  return new Function('window', 'navigator', 'crypto', 'bridge', source + '\nwindow.VCF_FIREBASE_READY = Promise.resolve(bridge); return { createFirebaseRepository, DataStore, Utils, MasterHelpers, Auth, normalizeTransaction, provisionAccount, createMemoryLocalStore };')(windowObject, {}, webcrypto, bridge);
}

export function memoryFirestore(initial = {}) {
  const records = new Map(Object.entries(initial).map(([key, value]) => [key, structuredClone(value)]));
  const versions = new Map();
  // docReads approximates billing: one per document returned (minimum one per query),
  // one per 1,000 matched entries for count/sum aggregations.
  const control = { commits: 0, failAt: 0, failAfterCommit: false, reads: 0, writes: 0, queries: 0, docReads: 0, aggregations: 0 };
  // Server timestamps resolve at commit and always increase, as in Firestore.
  let clock = Date.parse('2026-09-12T10:00:00Z');
  const resolveStamps = (value, now) => {
    if (!value || typeof value !== 'object' || value instanceof Date) return value;
    if (value.__serverTimestamp) return new Date(now);
    if (Array.isArray(value)) return value.map((item) => resolveStamps(item, now));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveStamps(item, now)]));
  };
  const listeners = new Map();
  const emit = (path) => { for (const cb of listeners.get(path) || []) cb(snapshot(path)); };
  const snapshot = (path) => ({ id: path.split('/').at(-1), exists: () => records.has(path), data: () => structuredClone(records.get(path)) });
  const orderValue = (path, row, field) => field === '__name__' ? path.split('/').at(-1) : row[field];
  const plain = (v) => v instanceof Date ? v.getTime() : (v && typeof v === 'object' && typeof v.seconds === 'number' ? v.seconds * 1000 + (v.nanoseconds || 0) / 1e6 : v);
  const compare = (a, b) => { const x = plain(a), y = plain(b); return x === y ? 0 : x < y ? -1 : 1; };
  const runQuery = ({ collection, constraints }) => {
    let rows = [...records].filter(([path]) => path.startsWith(collection + '/') && path.split('/').length === collection.split('/').length + 1);
    for (const f of constraints.filter((c) => c.kind === 'where')) rows = rows.filter(([path, row]) => {
      const value = orderValue(path, row, f.field);
      if (f.op === 'in') return f.value.includes(value);
      if (value === undefined) return false;
      const diff = compare(value, f.value);
      if (f.op === '>=') return diff >= 0;
      if (f.op === '<=') return diff <= 0;
      if (f.op === '>') return diff > 0;
      if (f.op === '<') return diff < 0;
      return diff === 0;
    });
    const orders = constraints.filter((c) => c.kind === 'order');
    rows = rows.filter(([path, row]) => orders.every((o) => orderValue(path, row, o.field) !== undefined));
    rows.sort(([ap, a], [bp, b]) => {
      for (const o of orders) {
        const diff = compare(orderValue(ap, a, o.field), orderValue(bp, b, o.field)) * (o.direction === 'desc' ? -1 : 1);
        if (diff) return diff;
      }
      return compare(ap, bp);
    });
    const after = constraints.find((c) => c.kind === 'after');
    if (after) rows = rows.filter(([path, row]) => {
      for (let i = 0; i < after.values.length; i++) {
        const diff = compare(orderValue(path, row, orders[i].field), after.values[i]) * (orders[i].direction === 'desc' ? -1 : 1);
        if (diff) return diff > 0;
      }
      return false;
    });
    const limit = constraints.find((c) => c.kind === 'limit');
    return limit ? rows.slice(0, limit.value) : rows;
  };
  const sdk = {
    doc: (_, ...parts) => parts.join('/'), collection: (_, name) => name, documentId: () => '__name__',
    where: (field, op, value) => ({ kind: 'where', field, op, value }),
    orderBy: (field, direction) => ({ kind: 'order', field, direction }),
    startAfter: (...values) => ({ kind: 'after', values }), limit: (value) => ({ kind: 'limit', value }),
    query: (collection, ...constraints) => ({ collection, constraints }),
    onSnapshot: (path, options, callback) => { if (!listeners.has(path)) listeners.set(path, new Set()); listeners.get(path).add(callback); queueMicrotask(() => { if (listeners.get(path).has(callback)) callback(snapshot(path)); }); return () => listeners.get(path).delete(callback); },
    getDocFromServer: async (path) => { control.reads++; control.docReads++; return snapshot(path); },
    getDocsFromServer: async (query) => {
      control.queries++;
      const rows = runQuery(query);
      control.docReads += Math.max(1, rows.length);
      return { docs: rows.map(([path]) => snapshot(path)), size: rows.length };
    },
    count: () => ({ kind: 'count' }), sum: (field) => ({ kind: 'sum', field }),
    getCountFromServer: async (query) => {
      control.aggregations++;
      const count = runQuery(query).length;
      control.docReads += Math.max(1, Math.ceil(count / 1000));
      return { data: () => ({ count }) };
    },
    getAggregateFromServer: async (query, spec) => {
      control.aggregations++;
      const rows = runQuery(query).map(([, row]) => row);
      control.docReads += Math.max(1, Math.ceil(rows.length / 1000));
      return { data: () => Object.fromEntries(Object.entries(spec).map(([key, item]) => [key, item.kind === 'count' ? rows.length : rows.reduce((sum, row) => sum + (Number(row[item.field]) || 0), 0)])) };
    },
    serverTimestamp: () => ({ __serverTimestamp: true }),
    setDoc: async (path, value, options = {}) => { value = resolveStamps(value, ++clock); records.set(path, options.merge ? { ...records.get(path), ...structuredClone(value) } : structuredClone(value)); versions.set(path, (versions.get(path) || 0) + 1); control.writes++; emit(path); },
    deleteDoc: async (path) => { records.delete(path); versions.set(path, (versions.get(path) || 0) + 1); },
    runTransaction: async (_, callback) => {
      for (let attempt = 0; attempt < 10; attempt++) {
        const reads = new Map(), writes = [];
        let writing = false;
        const result = await callback({
          get: async (path) => { control.reads++; if (writing) throw Error('Read after write'); reads.set(path, versions.get(path) || 0); return snapshot(path); },
          set: (path, value, options) => { writing = true; writes.push({ path, value, options }); },
          delete: (path) => { writing = true; writes.push({ path, remove: true }); },
        });
        if ([...reads].some(([path, version]) => (versions.get(path) || 0) !== version)) continue;
        control.commits++;
        if (control.failAt === control.commits && !control.failAfterCommit) throw Error('Simulated connection failure');
        const committedAt = ++clock;
        for (const w of writes) {
          if (w.remove) records.delete(w.path);
          else { const value = resolveStamps(w.value, committedAt); records.set(w.path, structuredClone(w.options?.merge ? { ...records.get(w.path), ...value } : value)); }
          versions.set(w.path, (versions.get(w.path) || 0) + 1); control.writes++;
        }
        writes.forEach((w) => emit(w.path));
        if (control.failAt === control.commits && control.failAfterCommit) throw Error('Simulated lost acknowledgment');
        return result;
      }
      throw Error('Too much contention');
    },
  };
  return { sdk, records, control };
}

export const master = { verticals: [{ id: 'v', name: 'Business' }], heads: [{ id: 'h', name: 'Expense', verticalId: 'v', appliesTo: 'outflow', group: 'opex' }], subHeads: [{ id: 's', headId: 'h', name: 'Rent' }], bankAccounts: [], _revision: 1 };
export const row = (id, extra = {}) => ({ id, date: '2026-09-10', month: '2026-09', source: 'cash', bankAccountId: '', type: 'outflow', status: 'uncategorized', withdrawal: 100, deposit: 0,
  particulars: 'Expense', verticalId: '', headId: '', subHeadId: '', hasClosingBalance: false, inflowNet: 0, outflowNet: 0, createdBy: 'admin', updatedBy: 'admin', createdAt: '2026-09-10T10:00:00Z', _revision: 1, ...extra });
