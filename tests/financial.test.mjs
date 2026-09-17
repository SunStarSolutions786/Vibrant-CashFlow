import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApplication, memoryFirestore, master, row } from './helpers.mjs';

function setup(initial = {}) {
  const memory = memoryFirestore(initial);
  const api = loadApplication();
  const repo = api.createFirebaseRepository(memory.sdk, {}, () => 'admin');
  return { ...memory, repo, api };
}
test('concurrent imports insert exactly one financial record', async () => {
  const { repo, records } = setup();
  const input = row('a', { importHash: 'hash', importBatchId: 'batch-a' });
  const results = await Promise.all([repo.importTransactions([input], false), repo.importTransactions([{ ...input, id: 'b', importBatchId: 'batch-b' }], false)]);
  assert.equal(results.reduce((s, r) => s + r.inserted, 0), 1);
  assert.equal(records.size, 2); // transaction + its month
});
test('reviewed duplicate import and its retry retain one accepted copy', async () => {
  const { repo, records } = setup();
  await repo.importTransactions([row('a', { importHash: 'hash', importBatchId: 'a' })], false);
  const duplicate = row('b', { importHash: 'hash', importBatchId: 'b' });
  await repo.importTransactions([duplicate], true);
  const retry = await repo.importTransactions([duplicate], true);
  assert.equal(retry.acceptedDuplicates, 1);
  assert.equal([...records.keys()].filter((p) => p.startsWith('transactions/')).length, 2);
});
test('partial import reports progress, saves month atomically, and resumes', async () => {
  const { repo, records, control } = setup();
  const rows = Array.from({ length: 17 }, (_, i) => row(String(i), { importHash: 'hash-' + i, importBatchId: 'batch' }));
  control.failAt = 2;
  await assert.rejects(repo.importTransactions(rows, false), (e) => e.savedRows.length === 8);
  assert.ok(records.has('dataMonths/2026-09'));
  control.failAt = 0;
  await repo.importTransactions(rows, false);
  assert.equal([...records.keys()].filter((p) => p.startsWith('transactions/')).length, 17);
});
test('retry after an import acknowledgment is lost does not add a duplicate', async () => {
  const { repo, records, control } = setup();
  const rows = [row('a', { importHash: 'hash', importBatchId: 'a' })];
  control.failAt = 1; control.failAfterCommit = true;
  await assert.rejects(repo.importTransactions(rows, true));
  control.failAt = 0;
  await repo.importTransactions(rows, true);
  assert.equal([...records.keys()].filter((p) => p.startsWith('transactions/')).length, 1);
});
test('two first budget saves cannot create duplicate categories', async () => {
  const { repo, records } = setup();
  const first = { id: 'a', month: '2026-09', subHeadId: 's', budget: 10000, booking: 0 };
  const saves = await Promise.allSettled([repo.saveBudgets('2026-09', [first], { s: null }, ['s'], false), repo.saveBudgets('2026-09', [{ ...first, id: 'b', budget: 12000 }], { s: null }, ['s'], false)]);
  assert.equal(saves.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal([...records.keys()].filter((p) => p.startsWith('budgets/')).length, 1);
});
test('budget replacement deletion and insertion roll back together on failure', async () => {
  const original = { id: 'old', month: '2026-09', subHeadId: 's', budget: 10000, booking: 0, _revision: 1 };
  const { repo, records, control } = setup({ 'budgets/old': original });
  control.failAt = 1;
  await assert.rejects(repo.saveBudgets('2026-09', [{ id: 'new', month: '2026-09', subHeadId: 't', budget: 2000, booking: 0 }], { s: 1 }, [], true));
  assert.deepEqual(records.get('budgets/old'), original); assert.equal(records.size, 1);
});
test('partial category saves resume without stale-revision errors for completed rows', async () => {
  const initial = Object.fromEntries(Array.from({ length: 9 }, (_, i) => ['transactions/' + i, row(String(i))]));
  const { repo, records, control } = setup(initial);
  const updates = Array.from({ length: 9 }, (_, i) => row(String(i), { _expectedRevision: 1, _operationId: 'operation-' + i, particulars: 'Corrected' }));
  control.failAt = 2;
  await assert.rejects(repo.upsertTransactions(updates), (e) => e.savedRows.length === 4);
  control.failAt = 0;
  await repo.upsertTransactions(updates);
  for (let i = 0; i < 9; i++) {
    assert.equal(records.get('transactions/' + i)._revision, 2);
    assert.equal(records.get('transactions/' + i + '/history/2').before.particulars, 'Expense');
  }
});
test('concurrent corrections reject the stale revision', async () => {
  const { repo } = setup({ 'transactions/a': row('a') });
  const saves = await Promise.allSettled(['one', 'two'].map((value) => repo.upsertTransactions([row('a', { _expectedRevision: 1, _operationId: value, particulars: value })])));
  assert.equal(saves.filter((r) => r.status === 'fulfilled').length, 1);
});
test('metadata changes appear on the next read and after logout', async () => {
  let settings = { editLockDays: 7 };
  const api = loadApplication({ getOne: async () => ({ ...settings }), auth: { logout: async () => {} } });
  assert.equal((await api.DataStore.getSettings()).editLockDays, 7);
  settings = { editLockDays: 0 }; assert.equal((await api.DataStore.getSettings()).editLockDays, 0);
  await api.Auth.logout(); assert.equal((await api.DataStore.getSettings()).editLockDays, 0);
});
test('pagination reaches older rows and searches beyond the former 250 row limit', async () => {
  const initial = Object.fromEntries(Array.from({ length: 301 }, (_, i) => ['transactions/' + String(i).padStart(4, '0'), row(String(i), { particulars: i === 0 ? 'Old invoice' : 'Recent invoice' })]));
  const { repo } = setup(initial); const api = loadApplication(repo);
  let after = null; const ids = new Set();
  do { const page = await api.DataStore.getTransactionPage({ after }); page.rows.forEach((r) => ids.add(r.id)); after = page.hasMore ? page.cursor : null; } while (after);
  assert.equal(ids.size, 301);
  const result = await api.DataStore.getTransactionPage({ search: 'Old invoice' });
  assert.equal(result.rows.length, 1); assert.equal(result.rows[0].id, '0000');
});
test('long searches expose continuation rather than falsely claiming there are no matches', async () => {
  const initial = Object.fromEntries(Array.from({ length: 1001 }, (_, i) => ['transactions/' + String(i).padStart(4, '0'), row(String(i), { particulars: i === 0 ? 'Needle' : 'Other' })]));
  const { repo } = setup(initial); const api = loadApplication(repo);
  const first = await api.DataStore.getTransactionPage({ search: 'Needle' });
  assert.equal(first.rows.length, 0); assert.equal(first.hasMore, true);
  const second = await api.DataStore.getTransactionPage({ search: 'Needle', after: first.cursor });
  assert.equal(second.rows.length, 1);
});
test('exact export limit succeeds; exceeding it fails explicitly', async () => {
  const { repo } = setup(Object.fromEntries(Array.from({ length: 50 }, (_, i) => ['transactions/' + i, row(String(i))])));
  assert.equal((await repo.listAll('transactions', { maxRows: 50 })).length, 50);
  await assert.rejects(repo.listAll('transactions', { maxRows: 49 }), /smaller date range/);
});
test('cash fingerprints distinguish businesses', async () => {
  const { Utils } = loadApplication(); const cash = row('a', { amount: 100 });
  assert.notEqual(await Utils.cashImportHash(Utils.canonicalCashRow({ ...cash, cashVerticalId: 'A' }), 1), await Utils.cashImportHash(Utils.canonicalCashRow({ ...cash, cashVerticalId: 'B' }), 1));
});
test('bank balances honor descending order and flag conflicting batches', () => {
  const { Utils } = loadApplication();
  const records = [1, 2].map((n) => row(String(n), { statementRowOrder: n, statementOrder: 'desc', importBatchId: 'a', closingBalance: n * 1000 }));
  assert.equal(Utils.latestStatementBalance(records).closingBalance, 1000);
  assert.equal(Utils.latestStatementBalance([...records, row('b', { closingBalance: 900, importBatchId: 'b' })]).balanceUncertain, true);
});
test('cancelled records no longer affect sums or closing balances', () => {
  const { normalizeTransaction } = loadApplication();
  const cancelled = normalizeTransaction(row('a', { status: 'void', closingBalance: 200, outflowNet: 100 }));
  assert.equal(cancelled.inflowNet, 0); assert.equal(cancelled.outflowNet, 0); assert.equal(cancelled.hasClosingBalance, false);
});
test('date, amount and historical category controls remain correct', () => {
  const { Utils, MasterHelpers } = loadApplication();
  assert.equal(Utils.toISODate('31/02/2026'), ''); assert.equal(Utils.parseAmountStrict('100abc'), null);
  assert.equal(Utils.netOutflow({ withdrawal: 0, deposit: 100 }), -100);
  const snapshot = MasterHelpers.snapshotForSelection(master, { verticalId: 'v', headId: 'h', subHeadId: 's' });
  const renamed = structuredClone(master); renamed.subHeads[0].name = 'Changed';
  assert.equal(MasterHelpers.resolveTransactionChain(renamed, { categorySnapshot: snapshot }).subHeadName, 'Rent');
});
test('interrupted user provisioning rolls back a newly created Auth account', async () => {
  const { provisionAccount } = loadApplication(); let deleted = false;
  await assert.rejects(provisionAccount({ create: async () => ({ user: { uid: 'new' } }), findProfile: async () => null,
    saveProfile: async () => { throw Error('profile failed'); }, deleteCreated: async () => { deleted = true; } }, 'new@example.test', 'password', {}), /profile failed/);
  assert.equal(deleted, true);
});
test('user provisioning recovers an existing identity but never overwrites an existing profile', async () => {
  const { provisionAccount } = loadApplication(); let saved;
  const adapter = { create: async () => { throw Object.assign(Error('exists'), { code: 'auth/email-already-in-use' }); },
    signIn: async () => ({ user: { uid: 'old' } }), findProfile: async () => null,
    saveProfile: async (id) => { saved = id; } };
  assert.equal(await provisionAccount(adapter, 'old@example.test', 'password', {}), 'old'); assert.equal(saved, 'old');
  adapter.findProfile = async () => ({ role: 'admin' }); saved = null;
  await assert.rejects(provisionAccount(adapter, 'old@example.test', 'password', {}), /already has/); assert.equal(saved, null);
});
test('existing duplicate budgets can be explicitly reconciled with an archive', async () => {
  const first = { id: 'a', month: '2026-09', subHeadId: 's', budget: 10000, booking: 0, _revision: 1 };
  const second = { ...first, id: 'b', budget: 12000 };
  const { repo, records, api } = setup({ 'budgets/a': first, 'budgets/b': second });
  await repo.reconcileBudgetDuplicates('2026-09', 's', 'b', api.Utils.budgetRevisionKey([first, second]));
  assert.equal(records.has('budgets/a'), false); assert.equal(records.get('budgets/b').budget, 12000);
  assert.equal([...records].find(([key]) => key.startsWith('budgetReconciliations/'))[1].before.length, 2);
});
test('balance review fingerprint changes after an additional or corrected statement', async () => {
  const { Utils } = loadApplication(); const original = [row('a', { closingBalance: 500 })];
  assert.notEqual(await Utils.balanceCandidatesKey(original), await Utils.balanceCandidatesKey([...original, row('b', { closingBalance: 400 })]));
  assert.notEqual(await Utils.balanceCandidatesKey(original), await Utils.balanceCandidatesKey([row('a', { closingBalance: 450 })]));
});

test('imports use no lookup queries and register a month only once', async () => {
  const { repo, control } = setup();
  const items = Array.from({ length: 24 }, (_, i) => row(String(i), { importHash: 'hash-' + i, importBatchId: 'batch' }));
  await repo.importTransactions(items, false);
  assert.equal(control.queries, 0); assert.equal(control.writes, 25);
  await repo.importTransactions(items, false);
  assert.equal(control.writes, 25);
});
test('live metadata saves repeat reads while remote updates and logout invalidate it', async () => {
  const { repo, sdk, control } = setup({ 'appData/masterData': master, 'appData/settings': { editLockDays: 7 }, 'users/admin': { active: true, role: 'admin' } });
  const { DataStore } = loadApplication(repo);
  const stop = await DataStore.watchMetadata('admin', () => {}, (error) => { throw error; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (let i = 0; i < 20; i++) { await DataStore.getMasterData(); await DataStore.getSettings(); await DataStore.getUser('admin'); }
  assert.equal(control.reads, 0);
  await sdk.setDoc('appData/settings', { editLockDays: 0 });
  assert.equal((await DataStore.getSettings()).editLockDays, 0);
  stop(); DataStore.clearCache(); await DataStore.getSettings(); assert.equal(control.reads, 1);
});
test('reports copy a month once, then read only changes; corrections move rows between months', async () => {
  const store = loadApplication().createMemoryLocalStore();
  const { repo, control } = setup({
    'appData/masterData': master,
    'transactions/aug': row('aug', { date: '2026-08-05', month: '2026-08', savedAt: new Date('2026-09-01T00:00:00Z') }),
    'transactions/sep': row('sep', { savedAt: new Date('2026-09-02T00:00:00Z') }),
    'dataMonths/2026-08': { month: '2026-08' }, 'dataMonths/2026-09': { month: '2026-09' },
  });
  const device = () => loadApplication(repo, { VCF_LOCAL_STORE: store }).DataStore;
  const first = device();
  const wide = await first.getReportData({ fromMonth: '2026-08', toMonth: '2026-09' });
  assert.deepEqual(wide.transactions.map((t) => t.id), ['sep', 'aug'], 'same order as a server query');
  assert.deepEqual(wide.months, ['2026-09', '2026-08']);

  let before = control.docReads;
  assert.deepEqual((await first.getReportData({ fromMonth: '2026-09', toMonth: '2026-09' })).transactions.map((t) => t.id), ['sep']);
  assert.equal(control.docReads - before, 1, 'revisit in the same session: one change-feed read');

  const second = device();
  before = control.docReads;
  await second.getReportData({ fromMonth: '2026-09', toMonth: '2026-09' });
  assert.equal(control.docReads - before, 2, 'new session: change feed plus a one-time totals check');

  await repo.upsertTransactions([row('sep', { date: '2026-08-20', month: '2026-08', _expectedRevision: 1, _operationId: 'move' })]);
  before = control.docReads;
  assert.deepEqual((await second.getReportData({ fromMonth: '2026-09', toMonth: '2026-09' })).transactions, []);
  assert.equal(control.docReads - before, 1, 'only the changed record is read');
  assert.deepEqual((await second.getReportData({ fromMonth: '2026-08', toMonth: '2026-08' })).transactions.map((t) => t.id), ['sep', 'aug']);
});
test('a record changed outside the app is caught by the monthly totals check', async () => {
  const store = loadApplication().createMemoryLocalStore();
  const { repo, records } = setup({
    'appData/masterData': master,
    'transactions/aug': row('aug', { date: '2026-08-05', month: '2026-08', status: 'categorized', verticalId: 'v', headId: 'h', subHeadId: 's', outflowNet: 100, savedAt: new Date('2026-09-01T00:00:00Z') }),
    'dataMonths/2026-08': { month: '2026-08' },
  });
  const device = () => loadApplication(repo, { VCF_LOCAL_STORE: store }).DataStore;
  await device().getReportData({ fromMonth: '2026-08', toMonth: '2026-08' });
  // e.g. edited in the Firebase console, so savedAt did not change
  records.set('transactions/aug', { ...records.get('transactions/aug'), withdrawal: 900, outflowNet: 900 });
  const report = await device().getReportData({ fromMonth: '2026-08', toMonth: '2026-08' });
  assert.equal(report.transactions[0].withdrawal, 900);
});
test('budgets reuse rows while the month lock is unchanged and saves skip re-reading the month', async () => {
  const store = loadApplication().createMemoryLocalStore();
  const { repo, control, records } = setup({
    'appData/masterData': master, 'budgetLocks/2026-09': { revision: 1 },
    'budgets/2026-09__s': { month: '2026-09', subHeadId: 's', budget: 10, booking: 0, _revision: 1 },
  });
  const { DataStore } = loadApplication(repo, { VCF_LOCAL_STORE: store });
  assert.equal((await DataStore.getBudgets('2026-09', '2026-09'))[0].budget, 10);
  let before = control.docReads;
  await DataStore.getBudgets('2026-09', '2026-09');
  assert.equal(control.docReads - before, 1, 'only the month lock is read');

  const queries = control.queries;
  await DataStore.patchBudgetsForMonth('2026-09', ['s'], [{ month: '2026-09', subHeadId: 's', budget: 25, booking: 0 }], { s: 1 });
  assert.equal(control.queries, queries, 'save trusts the verified month instead of re-reading it');
  before = control.docReads;
  assert.equal((await DataStore.getBudgets('2026-09', '2026-09'))[0].budget, 25);
  assert.equal(control.docReads - before, 1);

  // Another administrator saves: the stale local month cannot be written over.
  records.set('budgetLocks/2026-09', { revision: 3 });
  records.set('budgets/2026-09__s', { month: '2026-09', subHeadId: 's', budget: 40, booking: 0, _revision: 3 });
  await assert.rejects(DataStore.patchBudgetsForMonth('2026-09', ['s'], [{ month: '2026-09', subHeadId: 's', budget: 1, booking: 0 }], { s: 2 }), /changed while you were saving/);
  assert.equal((await DataStore.getBudgets('2026-09', '2026-09'))[0].budget, 40);
});
test('dashboard is reused while nothing changed and recomputed after any save', async () => {
  const store = loadApplication().createMemoryLocalStore();
  const { repo, control } = setup({ 'appData/masterData': master, 'transactions/a': row('a', { savedAt: new Date('2026-09-01T00:00:00Z') }) });
  const device = () => loadApplication(repo, { VCF_LOCAL_STORE: store }).DataStore;
  const md = { ...master, bankAccounts: [] };
  const first = device();
  assert.equal((await first.getDashboardData(md)).uncategorized, 1);
  const aggregations = control.aggregations;
  let before = control.docReads;
  await first.getDashboardData(md);
  assert.equal(control.docReads, before, 'immediate revisit is free');
  await device().getDashboardData(md);
  assert.equal(control.docReads - before, 1, 'new session with no changes: one change-feed read');
  assert.equal(control.aggregations, aggregations);
  await repo.upsertTransactions([row('b', { _operationId: 'new' })]);
  assert.equal((await device().getDashboardData(md)).uncategorized, 2);
  assert.ok(control.aggregations > aggregations, 'recomputed after a save');
});
test('startup waits for live listeners instead of reading profile, Master Data and Settings twice', async () => {
  const { repo, control } = setup({ 'users/admin': { name: 'Admin', username: 'a@example.com', role: 'admin', active: true }, 'appData/masterData': master, 'appData/settings': { editLockDays: 7 } });
  const { DataStore } = loadApplication(repo);
  assert.equal((await DataStore.getUser('admin')).role, 'admin');
  const [md, settings] = await Promise.all([DataStore.getMasterData(), DataStore.getSettings()]);
  assert.equal(md.subHeads.length, 1); assert.equal(settings.editLockDays, 7);
  const delivered = [];
  const stop = await DataStore.watchMetadata('admin', (key) => delivered.push(key), (error) => { throw error; });
  assert.deepEqual(delivered.sort(), ['masterData', 'settings', 'user:admin']);
  stop();
  assert.equal(control.reads, 0, 'no one-shot reads: the listeners supplied every value');
});
test('category suggestion memory is read once per session', async () => {
  const { repo, control } = setup({ 'appData/mappingMemory': { entries: [{ key: 'rent', mapping: { type: 'outflow', verticalId: 'v', headId: 'h', subHeadId: 's' } }] } });
  const { DataStore } = loadApplication(repo);
  for (let i = 0; i < 10; i++) assert.ok((await DataStore.getMappingMemory()).rent);
  assert.equal(control.reads, 1);
  DataStore.clearCache(); await DataStore.getMappingMemory(); assert.equal(control.reads, 2);
});
test('concurrent mapping updates merge without overwriting and unchanged suggestions skip writes', async () => {
  const { repo, records, control } = setup();
  const mapping = { type: 'outflow', verticalId: 'v', headId: 'h', subHeadId: 's' };
  await Promise.all([repo.rememberMappings([{ key: 'rent', mapping }], 100), repo.rememberMappings([{ key: 'office', mapping }], 100)]);
  assert.equal(records.get('appData/mappingMemory').entries.length, 2);
  const before = control.writes; await repo.rememberMappings([{ key: 'rent', mapping }], 100); assert.equal(control.writes, before);
});
test('single category search resolves hierarchy and ignores orphan rows', () => {
  const { MasterHelpers } = loadApplication();
  const md = { ...master, subHeads: [...master.subHeads, { id: 'bad', headId: 'missing', name: 'Orphan' }] };
  const options = MasterHelpers.categoryOptions(md);
  assert.equal(options.length, 1); assert.deepEqual(options[0].selection, { type: 'outflow', verticalId: 'v', headId: 'h', subHeadId: 's' });
  assert.strictEqual(MasterHelpers.categoryOptions(md), options);
});
test('month picker reads the registry once per device, then only the change feed', async () => {
  const store = loadApplication().createMemoryLocalStore();
  const { repo, control } = setup({ 'dataMonths/2025-01': { month: '2025-01' }, 'dataMonths/2026-09': { month: '2026-09' } });
  const device = () => loadApplication(repo, { VCF_LOCAL_STORE: store }).DataStore;
  assert.deepEqual(await device().getAvailableMonths(), ['2026-09', '2025-01']);
  const queries = control.queries;
  assert.deepEqual(await device().getAvailableMonths(), ['2026-09', '2025-01']);
  assert.equal(control.queries - queries, 1);
});
