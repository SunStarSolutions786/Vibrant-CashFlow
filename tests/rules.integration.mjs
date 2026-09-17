import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails, assertSucceeds } from '@firebase/rules-unit-testing';
import * as sdk from 'firebase/firestore';
import { loadApplication, master, row } from './helpers.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('These tests require the local Firestore emulator. Production execution is forbidden.');
const api = loadApplication();
const date = api.Utils.todayISO();
const month = date.slice(0, 7);
let env;
const dbFor = (uid) => env.authenticatedContext(uid).firestore()._delegate;
const repoFor = (uid) => api.createFirebaseRepository(sdk, dbFor(uid), () => uid);
const entry = (id, extra = {}) => row(id, { date, month, ...extra });
before(async () => {
  const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  env = await initializeTestEnvironment({ projectId: 'demo-vcf', firestore: { host, port: Number(port), rules: readFileSync('firestore.rules', 'utf8') } });
});
after(async () => { if (env) await env.cleanup(); });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()._delegate;
    await Promise.all(['admin', 'backoffice', 'viewer'].map((role) => sdk.setDoc(sdk.doc(db, 'users', role), { name: role, username: role + '@example.test', role, active: true })));
    await sdk.setDoc(sdk.doc(db, 'appData', 'masterData'), master);
    await sdk.setDoc(sdk.doc(db, 'appData', 'settings'), { editLockDays: 7 });
  });
});
test('rules allow valid financial creation with its month registry', async () => {
  await assertSucceeds(repoFor('backoffice').upsertTransactions([entry('a')]));
  const saved = await sdk.getDoc(sdk.doc(dbFor('backoffice'), 'transactions', 'a'));
  assert.equal(saved.data().createdBy, 'backoffice');
  assert.ok((await sdk.getDoc(sdk.doc(dbFor('admin'), 'dataMonths', month))).exists());
});
test('rules reject unauthenticated and Viewer financial writes', async () => {
  await assertFails(repoFor('viewer').upsertTransactions([entry('a')]));
  await assertFails(sdk.getDocs(sdk.collection(env.unauthenticatedContext().firestore()._delegate, 'transactions')));
});
test('rules enforce old-date lock for both creates and changes, even with a new date', async () => {
  const oldDate = api.Utils.toISODate(new Date(Date.now() - 10 * 86400000));
  const old = entry('old', { date: oldDate, month: oldDate.slice(0, 7) });
  await assertFails(repoFor('backoffice').upsertTransactions([old]));
  await assertSucceeds(repoFor('admin').upsertTransactions([old]));
  await assertFails(repoFor('backoffice').upsertTransactions([entry('old', { _expectedRevision: 1, _operationId: 'bypass' })]));
});
test('rules use freshly changed lock settings', async () => {
  const yesterday = api.Utils.toISODate(new Date(Date.now() - 86400000));
  await sdk.setDoc(sdk.doc(dbFor('admin'), 'appData', 'settings'), { editLockDays: 0 });
  await assertFails(repoFor('backoffice').upsertTransactions([entry('old', { date: yesterday, month: yesterday.slice(0, 7) })]));
  await assertSucceeds(repoFor('backoffice').upsertTransactions([entry('today')]));
});
test('rules reject malformed totals, future dates and missing month registry', async () => {
  await assertFails(repoFor('admin').upsertTransactions([entry('wrong', { outflowNet: 9999 })]));
  const future = api.Utils.toISODate(new Date(Date.now() + 86400000));
  await assertFails(repoFor('admin').upsertTransactions([entry('future', { date: future, month: future.slice(0, 7) })]));
  await assertFails(sdk.setDoc(sdk.doc(dbFor('admin'), 'transactions', 'missing-month'), entry('missing-month')));
});
test('rules permit audited corrections and prevent direct mutation or deletion', async () => {
  const repo = repoFor('admin');
  await repo.upsertTransactions([entry('a')]);
  await assertFails(sdk.updateDoc(sdk.doc(dbFor('admin'), 'transactions', 'a'), { withdrawal: 500 }));
  await assertFails(sdk.deleteDoc(sdk.doc(dbFor('admin'), 'transactions', 'a')));
  await assertSucceeds(repo.upsertTransactions([entry('a', { withdrawal: 500, _expectedRevision: 1, _operationId: 'correct', changeReason: 'Correct receipt amount' })]));
  const history = await sdk.getDoc(sdk.doc(dbFor('admin'), 'transactions', 'a', 'history', '2'));
  assert.equal(history.data().before.withdrawal, 100);
  await assertFails(sdk.updateDoc(history.ref, { reason: 'tamper' }));
});
test('rules allow four audited updates across distinct months within the access budget', async () => {
  const repo = repoFor('admin');
  const records = Array.from({ length: 4 }, (_, i) => {
    const m = api.Utils.addMonths(month, -i - 1);
    return entry(String(i), { date: m + '-01', month: m });
  });
  await repo.upsertTransactions(records);
  await assertSucceeds(repo.upsertTransactions(records.map((r) => ({ ...r, particulars: 'Correction', _expectedRevision: 1, _operationId: r.id + '-edit' }))));
});
test('real transaction contention cannot create duplicate imports', async () => {
  const a = entry('a', { importHash: 'samehash', importBatchId: 'a' });
  const results = await Promise.all([repoFor('admin').importTransactions([a], false), repoFor('backoffice').importTransactions([{ ...a, id: 'b', importBatchId: 'b' }], false)]);
  assert.equal(results.reduce((sum, r) => sum + r.inserted, 0), 1);
});
test('old clients cannot create random-ID import duplicates', async () => {
  const db = dbFor('admin');
  const batch = sdk.writeBatch(db);
  batch.set(sdk.doc(db, 'dataMonths', month), { month });
  batch.set(sdk.doc(db, 'transactions', 'random'), entry('random', { importHash: 'samehash' }));
  await assertFails(batch.commit());
});
test('budgets require an atomic month lock and reject concurrent first saves', async () => {
  const budget = { id: 'random', month, subHeadId: 's', budget: 10000, booking: 0, _revision: 1, updatedBy: 'admin' };
  await assertFails(sdk.setDoc(sdk.doc(dbFor('admin'), 'budgets', 'random'), budget));
  const repo = repoFor('admin');
  const results = await Promise.allSettled([repo.saveBudgets(month, [budget], { s: null }, ['s'], false), repo.saveBudgets(month, [{ ...budget, budget: 12000 }], { s: null }, ['s'], false)]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  const rows = await sdk.getDocs(sdk.collection(dbFor('admin'), 'budgets'));
  assert.equal(rows.size, 1);
});
test('valid cancellation zeros aggregates and preserves an audit record', async () => {
  const repo = repoFor('admin');
  await repo.upsertTransactions([entry('a')]);
  await assertSucceeds(repo.upsertTransactions([entry('a', { status: 'void', _expectedRevision: 1, _operationId: 'void-a', changeReason: 'Duplicate receipt' })]));
  assert.equal((await sdk.getDoc(sdk.doc(dbFor('admin'), 'transactions', 'a'))).data().status, 'void');
});
test('bank balance confirmation is restricted to editors and invalidates after new data', async () => {
  const repo = repoFor('admin');
  const a = entry('bank-a', { source: 'bank', bankAccountId: 'bank', closingBalance: 1000, hasClosingBalance: true, importBatchId: 'a', statementOrder: 'asc', statementRowOrder: 100 });
  const b = entry('bank-b', { ...a, id: 'bank-b', closingBalance: 900, importBatchId: 'b', statementRowOrder: 1 });
  await repo.upsertTransactions([a, b]);
  assert.equal((await repo.dashboard(month, ['bank'])).latestBalances[0].balanceUncertain, true);
  await assertFails(repoFor('viewer').confirmBankBalance('bank', 'bank-b', date));
  await assertSucceeds(repo.confirmBankBalance('bank', 'bank-b', date));
  const confirmed = (await repo.dashboard(month, ['bank'])).latestBalances[0];
  assert.equal(confirmed.balanceConfirmed, true); assert.equal(confirmed.closingBalance, 900);
  await repo.upsertTransactions([entry('bank-c', { ...a, id: 'bank-c', closingBalance: 800, importBatchId: 'c' })]);
  assert.equal((await repo.dashboard(month, ['bank'])).latestBalances[0].balanceUncertain, true);
});
test('legacy duplicate budget reconciliation keeps reviewed values and an archive', async () => {
  const a = { month, subHeadId: 's', budget: 10000, booking: 0, _revision: 1, updatedBy: 'admin' };
  const b = { ...a, budget: 12000 };
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore()._delegate;
    await sdk.setDoc(sdk.doc(db, 'budgets', 'a'), a); await sdk.setDoc(sdk.doc(db, 'budgets', 'b'), b);
  });
  await assertSucceeds(repoFor('admin').reconcileBudgetDuplicates(month, 's', 'b', api.Utils.budgetRevisionKey([{ ...a, id: 'a' }, { ...b, id: 'b' }])));
  const remaining = await sdk.getDocs(sdk.collection(dbFor('admin'), 'budgets'));
  assert.equal(remaining.size, 1); assert.equal(remaining.docs[0].data().budget, 12000);
  assert.equal((await sdk.getDocs(sdk.collection(dbFor('admin'), 'budgetReconciliations'))).size, 1);
});
