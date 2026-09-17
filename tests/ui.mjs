import { createServer } from 'node:http';
import { readFile, mkdir, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import { transform } from 'esbuild';
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import XLSX from 'xlsx';
import { loadApplication, memoryFirestore, master, row } from './helpers.mjs';

// Uses VCF_CHROMIUM when set, otherwise any Playwright-installed Chromium on
// Windows, macOS or Linux, otherwise Playwright's own default lookup.
async function findChromium() {
  if (process.env.VCF_CHROMIUM) return process.env.VCF_CHROMIUM;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  const binaries = [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe'], ['chrome-linux', 'chrome'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']];
  for (const cache of caches) {
    let dirs = [];
    try { dirs = (await readdir(cache)).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse(); } catch { continue; }
    for (const dir of dirs) for (const parts of binaries) {
      const candidate = path.join(cache, dir, ...parts);
      try { await access(candidate); return candidate; } catch { /* try next */ }
    }
  }
  return undefined;
}

const today = loadApplication().Utils.todayISO();
const month = today.slice(0, 7);
const initial = {
  'users/admin': { name: 'Admin', username: 'admin@example.test', role: 'admin', active: true },
  'users/viewer': { name: 'Viewer', username: 'viewer@example.test', role: 'viewer', active: true },
  'appData/masterData': { ...master, bankAccounts: [{ id: 'bank', name: 'Test Bank', verticalId: 'v' }] },
  'appData/settings': { editLockDays: 7 },
  ['dataMonths/' + month]: { month },
};
initial['appData/masterData'].verticals = [...master.verticals, { id: 'v2', name: 'Business B' }];
for (const [id, budget] of [['legacy-a', 100], ['legacy-b', 200]]) initial['budgets/' + id] = {
  month, subHeadId: 's', budget, booking: 0, _revision: 1, updatedBy: 'admin',
};
for (const [id, closingBalance] of [['balance-a', 1000], ['balance-b', 900]]) initial['transactions/' + id] = row(id, {
  date: today, month, source: 'bank', bankAccountId: 'bank', bankName: 'Test Bank', closingBalance, hasClosingBalance: true,
  importBatchId: id, importedAt: today + 'T10:00:00Z', statementOrder: 'asc', statementRowOrder: 1,
});
for (let i = 0; i < 301; i++) initial['transactions/txn-' + String(i).padStart(4, '0')] = row('unused', {
  date: today, month, particulars: i === 0 ? 'Old invoice' : 'Expense ' + i, createdAt: today + 'T10:00:00Z',
});
// Firestore document IDs are metadata, not a stored field.
Object.values(initial).forEach((r) => { delete r.id; });
const stub = `
window.__testMemory = (${memoryFirestore.toString()})(${JSON.stringify(initial)});
const testSdk = window.__testMemory.sdk;
let testUser = { uid: 'admin' }; const authListeners = new Set();
window.__setUser = (uid) => { testUser = uid ? { uid } : null; authListeners.forEach((cb) => cb(testUser)); };
window.FirebaseBridge = { ...createFirebaseRepository(testSdk, {}, () => testUser?.uid), auth: {
  current: async () => testUser, onChange: (cb) => { authListeners.add(cb); queueMicrotask(() => cb(testUser)); return () => authListeners.delete(cb); },
  logout: async () => window.__setUser(null), login: async () => { window.__setUser('admin'); return testUser; },
} };
window.vcfResolveFirebase(window.FirebaseBridge);
`;
const files = ['config', 'utils', 'masterHelpers', 'firebaseRepository'];
const pages = ['Login', 'Dashboard', 'UploadStatement', 'CashEntry', 'TransactionEditor', 'Categorize', 'InflowAnalysis', 'OutflowAnalysis', 'BudgetBooking', 'MasterData', 'Users', 'ExportReports'];
const source = (await Promise.all(files.map((f) => readFile('js/' + f + '.js', 'utf8')))).join('\n') + '\n' + stub + '\n' +
  (await Promise.all(['js/localStore.js', 'js/dataStore.js', 'js/auth.js', 'js/components.js', ...pages.map((f) => 'js/pages/' + f + '.js'), 'js/app.js'].map((f) => readFile(f, 'utf8')))).join('\n');
const bundle = (await transform(source, { loader: 'jsx', format: 'esm', target: 'es2022' })).code;
const scriptPaths = {
  '/assets/vendor/react-18.3.1.min.js': 'node_modules/react/umd/react.production.min.js',
  '/assets/vendor/react-dom-18.3.1.min.js': 'node_modules/react-dom/umd/react-dom.production.min.js',
  '/assets/vendor/xlsx-0.20.3.min.js': 'node_modules/xlsx/dist/xlsx.full.min.js',
  '/assets/vendor/exceljs-4.4.0.min.js': 'node_modules/exceljs/dist/exceljs.min.js',
};
let html = await readFile('index.html', 'utf8');
html = html.replace(/src="js\/app\.bundle\.min\.js[^\"]*"/, 'src="/test-app.js"');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
    if (pathname === '/test-app.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(bundle); return; }
    const local = scriptPaths[pathname] || (pathname === '/styles.css' ? 'styles.css' : pathname === '/assets/vibrant-logo.png' ? 'assets/vibrant-logo.png' : null);
    if (!local) { response.writeHead(404); response.end(); return; }
    response.setHeader('Content-Type', local.endsWith('.js') ? 'text/javascript' : local.endsWith('.css') ? 'text/css' : 'image/png');
    response.end(await readFile(local));
  } catch (error) { response.writeHead(500); response.end(error.message); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const artifacts = 'tests/artifacts'; await mkdir(artifacts, { recursive: true });
let browser;
try {
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = []; page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.fulfill({ status: 200, body: '' }));
  await page.goto(base);
  await page.getByText('Awaiting Categorization', { exact: true }).waitFor();
  await page.getByText('Needs review', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Review closing balance', exact: true }).click();
  await page.getByRole('dialog').getByRole('row').filter({ has: page.getByRole('cell', { name: '₹900.00', exact: true }) }).getByRole('button', { name: 'Use this closing balance' }).click();
  await page.getByText('Closing balance confirmed. New or corrected statements will be checked again.', { exact: true }).waitFor();
  console.log('PASS: conflicting bank balances require review and can be confirmed');
  await page.getByRole('link', { name: 'Categorize', exact: true }).click();
  // Wait for the Categorize page itself: the dashboard also renders a data table.
  await page.getByText('Categorize this page', { exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelectorAll('table.dtable tbody tr').length === 50, null, { timeout: 15000 });
  assert.equal(await page.locator('table.dtable tbody tr').count(), 50);
  assert.equal(await page.evaluate(() => typeof window.XLSX), 'undefined');
  assert.equal(await page.evaluate(() => typeof window.ExcelJS), 'undefined');
  await page.getByRole('button', { name: 'Step by step', exact: true }).click();
  let first = page.locator('table.dtable tbody tr').first();
  await first.getByRole('combobox', { name: 'Vertical', exact: true }).click();
  await page.getByRole('option', { name: 'Business', exact: true }).click();
  await first.getByRole('combobox', { name: 'Head', exact: true }).click();
  await page.getByRole('option', { name: 'Expense', exact: true }).click();
  await first.getByRole('combobox', { name: 'Sub-head', exact: true }).click();
  await page.getByRole('option', { name: 'Rent', exact: true }).click();
  await page.getByRole('button', { name: 'All Transactions', exact: true }).click();
  await page.getByRole('button', { name: 'Save changes (1 drafts)', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Next →', exact: true }).click();
  await page.getByText('Page 2', { exact: true }).waitFor();
  await page.getByRole('button', { name: '← Prev', exact: true }).click();
  await page.getByText('Page 1', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Save changes (1 drafts)', exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('link', { name: 'Outflow Analysis', exact: true }).click();
  await page.waitForURL(/#\/categorize$/);
  assert.ok(page.url().endsWith('#/categorize'));
  await page.getByRole('button', { name: 'Save changes (1 drafts)', exact: true }).click();
  await page.getByText('Saved 1 transaction(s).', { exact: true }).waitFor();
  console.log('PASS: category drafts survive pagination/tab changes; navigation guard and saving work');

  await page.getByRole('textbox', { name: 'Search all transactions' }).fill('Old invoice');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('cell', { name: 'Old invoice', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Details / Correct', exact: true }).click();
  const correctionInput = page.getByRole('spinbutton', { name: 'Correction withdrawal' });
  await correctionInput.fill(''); await correctionInput.pressSequentially('500.55');
  assert.equal(await correctionInput.inputValue(), '500.55');
  assert.equal(await correctionInput.evaluate((element) => element === document.activeElement), true);
  await page.getByRole('textbox', { name: 'Correction reason' }).fill('Correct receipt amount');
  await page.getByRole('button', { name: 'Save correction', exact: true }).click();
  await page.getByText('Correction saved with history.', { exact: true }).waitFor();
  const corrected = await page.evaluate(() => window.__testMemory.records.get('transactions/txn-0000'));
  assert.equal(corrected.withdrawal, 500.55); assert.equal(corrected._revision, 2);
  await page.getByRole('button', { name: 'Details / Correct', exact: true }).click();
  await page.getByRole('cell', { name: 'Correct receipt amount admin' }).waitFor();
  await page.getByRole('textbox', { name: 'Correction reason' }).fill('Duplicate receipt');
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Cancel transaction', exact: true }).click();
  await page.getByText('Transaction cancelled.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => window.__testMemory.records.get('transactions/txn-0000').status), 'void');
  console.log('PASS: search reaches old entries; corrections and cancellation preserve history');

  await page.getByRole('link', { name: 'Cash Entry', exact: true }).click();
  await page.getByRole('combobox', { name: 'Select cash business', exact: true }).click();
  await page.getByRole('option', { name: 'Business', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Amount (₹)' }).fill('12.34');
  await page.getByRole('button', { name: 'Save Cash Entry', exact: true }).click();
  await page.getByText('Entry saved. Ready to categorize later.', { exact: true }).waitFor();
  console.log('PASS: cash business selection and decimal entry');

  function spreadsheet(name, rows) {
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Entries');
    return { name, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) };
  }
  await page.getByRole('button', { name: '⬆️ Upload File', exact: true }).click();
  const cashFile = spreadsheet('cash.xlsx', [['Date', 'Type', 'Amount', 'Particulars', 'Vertical'],
    [today, 'Outflow', 55, 'Transport', 'Business'], [today, 'Outflow', 55, 'Transport', 'Business B']]);
  await page.locator('input[type=file]').setInputFiles(cashFile);
  await page.getByRole('button', { name: 'Import 2 row(s)', exact: true }).click();
  await page.getByText('2 imported', { exact: true }).waitFor();
  await page.locator('input[type=file]').setInputFiles(cashFile);
  await page.getByRole('button', { name: 'Import 2 row(s)', exact: true }).click();
  await page.getByText('2 duplicates skipped', { exact: true }).waitFor();
  const largerFile = spreadsheet('retry.xlsx', [['Date', 'Type', 'Amount', 'Particulars', 'Vertical'], ...Array.from({ length: 9 }, (_, i) => [today, 'Outflow', 10 + i, 'Retry ' + i, 'Business'])]);
  await page.locator('input[type=file]').setInputFiles(largerFile);
  const beforeImport = await page.evaluate(() => { window.__testMemory.control.failAt = window.__testMemory.control.commits + 2; return [...window.__testMemory.records.keys()].filter((k) => k.startsWith('transactions/') && !k.includes('/history/')).length; });
  await page.getByRole('button', { name: 'Import 9 row(s)', exact: true }).click();
  await page.locator('p.error-text').filter({ hasText: '8 of 9 rows saved' }).waitFor();
  await page.evaluate(() => { window.__testMemory.control.failAt = 0; });
  await page.getByRole('button', { name: 'Import 9 row(s)', exact: true }).click();
  await page.getByText('9 imported', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => [...window.__testMemory.records.keys()].filter((k) => k.startsWith('transactions/') && !k.includes('/history/')).length), beforeImport + 9);
  console.log('PASS: real cash workbook parsing, distinct businesses, duplicates, partial-import retry');

  await page.getByRole('link', { name: 'Statement', exact: true }).click();
  await page.getByRole('button', { name: '⬆️ Upload File', exact: true }).click();
  await page.getByRole('button', { name: 'Newest first', exact: true }).click();
  await page.locator('input[type=file]').setInputFiles(spreadsheet('bank.xlsx', [['Bank Name', 'Date', 'Particulars', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance'],
    ['Test Bank', today, 'Later payment', 50, 0, 900], ['Test Bank', today, 'Earlier payment', 100, 0, 950]]));
  await page.getByRole('button', { name: 'Import 2 row(s)', exact: true }).click();
  await page.getByText('2 imported', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => [...window.__testMemory.records.values()].find((r) => r.particulars === 'Later payment').statementOrder), 'desc');
  console.log('PASS: real bank workbook import records its posting order');

  await page.getByRole('link', { name: 'Budget & Booking', exact: true }).click();
  await page.getByText('Duplicate budgets need review', { exact: true }).waitFor();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: 'Keep these figures', exact: true }).first().click();
  await page.getByText('Duplicate budgets reconciled.', { exact: true }).waitFor();
  await page.getByRole('spinbutton', { name: 'Rent budget', exact: true }).fill('1000.25');
  await page.getByRole('spinbutton', { name: 'Rent booking', exact: true }).fill('500.50');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByText('Budget & Booking saved.', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Export Reports', exact: true }).click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '📤 Excel Workbook (.xlsx)', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(artifacts, 'report.xlsx'));
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.readFile(path.join(artifacts, 'report.xlsx'));
  const outflow = workbook.getWorksheet('OUTFLOW');
  const total = outflow.getRow(outflow.rowCount);
  assert.equal(total.getCell(5).value, 1000.25); assert.equal(total.getCell(7).value, 100);
  assert.ok(workbook.getWorksheet('Raw Data'));
  console.log('PASS: budget save and downloaded Excel reconciliation');

  await page.getByRole('link', { name: 'Statement', exact: true }).click();
  await page.getByRole('button', { name: '+ Add Entry', exact: true }).click();
  await page.getByRole('combobox', { name: 'Bank Account', exact: true }).click();
  await page.getByRole('option', { name: 'Test Bank', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Amount (₹)' }).fill('45.67');
  await page.getByRole('textbox', { name: 'Particulars', exact: true }).fill('Direct bank category');
  await page.getByRole('checkbox', { name: 'Categorize now Optional' }).check();
  await page.getByRole('combobox', { name: 'Search Master categories', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search Search Master categories', exact: true }).fill('rent business');
  await page.getByRole('option', { name: 'Business / Expense / Rent · outflow', exact: true }).click();
  await page.getByRole('button', { name: 'Choose step by step', exact: true }).click();
  assert.ok((await page.getByRole('combobox', { name: 'Vertical', exact: true }).innerText()).includes('Business'));
  await page.getByRole('button', { name: 'Save Entry', exact: true }).click();
  await page.getByText('Entry saved and categorized.', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => [...window.__testMemory.records.values()].find((r) => r.particulars === 'Direct bank category').status), 'categorized');
  await page.getByRole('link', { name: 'Cash Entry', exact: true }).click();
  await page.getByRole('spinbutton', { name: 'Amount (₹)' }).fill('23.45');
  await page.getByRole('textbox', { name: 'Particulars', exact: true }).fill('Direct cash category');
  await page.getByRole('checkbox', { name: 'Categorize now Optional' }).check();
  await page.getByRole('combobox', { name: 'Search Master categories', exact: true }).click();
  await page.getByRole('option', { name: 'Business / Expense / Rent · outflow', exact: true }).click();
  await page.getByRole('button', { name: 'Save Cash Entry', exact: true }).click();
  await page.waitForFunction(() => [...window.__testMemory.records.values()].some((r) => r.particulars === 'Direct cash category'));
  const directCash = await page.evaluate(() => [...window.__testMemory.records.values()].find((r) => r.particulars === 'Direct cash category'));
  assert.equal(directCash.status, 'categorized'); assert.equal(directCash.cashVerticalId, 'v'); assert.equal(directCash.categorySnapshot.subHeadName, 'Rent');
  await page.getByRole('link', { name: 'Categorize', exact: true }).click();
  let searchableRow = page.locator('table.dtable tbody tr').first();
  await searchableRow.getByRole('combobox', { name: 'Search Master categories', exact: true }).click();
  await page.getByRole('combobox', { name: 'Search Search Master categories', exact: true }).fill('expense rent');
  await page.getByRole('option', { name: 'Business / Expense / Rent · outflow', exact: true }).click();
  await page.getByRole('button', { name: 'Step by step', exact: true }).click();
  assert.ok((await searchableRow.getByRole('combobox', { name: 'Head', exact: true }).innerText()).includes('Expense'));
  await page.getByRole('button', { name: 'Save changes (1 drafts)', exact: true }).click();
  await page.getByText('Saved 1 transaction(s).', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Single search', exact: true }).click();
  await page.screenshot({ path: path.join(artifacts, 'categorize-desktop.png'), fullPage: false });
  console.log('PASS: optional direct bank/cash categorization, token search and automatic hierarchy fill');

  await page.getByRole('link', { name: 'Master Data', exact: true }).click();
  await page.getByRole('button', { name: 'Heads & Sub-heads', exact: true }).click();
  await page.getByRole('cell', { name: 'Rent', exact: true }).waitFor();
  await page.evaluate(async () => {
    const master = structuredClone(window.__testMemory.records.get('appData/masterData'));
    master.subHeads.push(...Array.from({ length: 120 }, (_, i) => ({ id: 'large-' + i, headId: 'h', name: 'Extra ' + i })));
    await window.__testMemory.sdk.setDoc('appData/masterData', master);
  });
  await page.getByText('121 items · Page 1', { exact: true }).waitFor();
  assert.equal(await page.locator('table.dtable tbody tr').count(), 50);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await page.getByText('121 items · Page 2', { exact: true }).waitFor();
  assert.equal(await page.locator('table.dtable tbody tr').count(), 50);
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await page.locator('table.dtable tbody tr').count(), 21);
  console.log('PASS: live Master updates and pagination with 121 category rows');
  const billed = () => page.evaluate(() => ({ reads: window.__testMemory.control.docReads, aggregations: window.__testMemory.control.aggregations }));
  await page.getByRole('link', { name: 'Outflow Analysis', exact: true }).click();
  await page.getByText('By Month', { exact: true }).waitFor();
  await page.getByText(/^Updated \d{1,2}:\d{2}/).waitFor();
  const outflowLoaded = await billed();
  await page.getByRole('link', { name: 'Inflow Analysis', exact: true }).click();
  await page.getByText('Head-wise', { exact: true }).waitFor();
  await page.getByRole('link', { name: 'Outflow Analysis', exact: true }).click();
  await page.getByText('By Month', { exact: true }).waitFor();
  const revisited = await billed();
  assert.ok(revisited.reads - outflowLoaded.reads <= 3, `revisits read only the change feed and budget lock (${revisited.reads - outflowLoaded.reads} reads)`);
  assert.equal(revisited.aggregations, outflowLoaded.aggregations);
  assert.equal(await page.evaluate(async () => (await window.indexedDB.databases()).some((db) => db.name.startsWith('vcf-local-'))), true, 'report data is kept in IndexedDB');
  await page.getByRole('button', { name: /Refresh/ }).click();
  // The page is already visible before Refresh starts, so wait for the server check itself.
  await page.waitForFunction((before) => window.__testMemory.control.aggregations > before, revisited.aggregations, { timeout: 15000 });
  await page.getByText('By Month', { exact: true }).waitFor();
  await page.getByRole('button', { name: /Refresh/ }).waitFor();
  await page.waitForTimeout(900); await page.screenshot({ path: path.join(artifacts, 'outflow-desktop.png') });
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByText('Awaiting Categorization', { exact: true }).waitFor();
  const dashboardLoaded = await billed();
  await page.getByRole('link', { name: 'Inflow Analysis', exact: true }).click();
  await page.getByText('Head-wise', { exact: true }).waitFor();
  const inflowAgain = await billed();
  await page.getByRole('link', { name: 'Dashboard', exact: true }).click();
  await page.getByText('Awaiting Categorization', { exact: true }).waitFor();
  assert.deepEqual(await billed(), inflowAgain, 'returning to the dashboard costs no reads');
  assert.ok(inflowAgain.reads - dashboardLoaded.reads <= 1);
  await page.waitForTimeout(900); await page.screenshot({ path: path.join(artifacts, 'dashboard-desktop.png') });
  console.log('PASS: reports sync changes into IndexedDB, Refresh re-checks totals, dashboard revisits are free');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('link', { name: 'Categorize', exact: true }).click();
  await page.locator('table.dtable tbody tr').first().waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.screenshot({ path: path.join(artifacts, 'categorize-mobile.png'), fullPage: true });
  await page.evaluate(() => window.__setUser('viewer'));
  await page.getByText('Awaiting Categorization', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: 'Categorize', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
  console.log('PASS: mobile layout, account-change handling, no browser exceptions');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
