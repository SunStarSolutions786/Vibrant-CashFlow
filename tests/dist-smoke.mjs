// Serves the built dist/ folder exactly as a static host would and checks that
// the shipped bundle starts. Firebase SDK modules are replaced with small stubs
// so this runs offline and never touches the production project.
// Run after "npm run build":  npm run test:dist
import { createServer } from 'node:http';
import { readFile, readdir, access } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const root = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.txt': 'text/plain' };

async function findChromium() {
  if (process.env.VCF_CHROMIUM) return process.env.VCF_CHROMIUM;
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const caches = [process.env.PLAYWRIGHT_BROWSERS_PATH, process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'ms-playwright'),
    path.join(home, '.cache', 'ms-playwright'), path.join(home, 'Library', 'Caches', 'ms-playwright')].filter(Boolean);
  const binaries = [['chrome-win64', 'chrome.exe'], ['chrome-win', 'chrome.exe'], ['chrome-linux', 'chrome'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']];
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

const firebaseStubs = {
  'firebase-app.js': 'export const initializeApp = () => ({}); export const deleteApp = async () => {};',
  'firebase-firestore.js': 'export const initializeFirestore = () => ({}); export const getFirestore = () => ({}); export const memoryLocalCache = () => ({}); export const memoryEagerGarbageCollector = () => ({});',
  'firebase-auth.js': 'export const getAuth = () => ({ currentUser: null, authStateReady: async () => {} }); export const setPersistence = async () => {}; export const browserLocalPersistence = {}; export const inMemoryPersistence = {}; export const onAuthStateChanged = () => () => {};',
};

await access(path.join(root, 'index.html')).catch(() => { throw new Error('dist/index.html not found. Run "npm run build" first.'); });
const server = createServer(async (request, response) => {
  try {
    let pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = path.join(root, pathname);
    if (!file.startsWith(root)) { response.writeHead(403); response.end(); return; }
    const body = await readFile(file);
    response.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
    response.end(body);
  } catch { response.writeHead(404); response.end('Not found'); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/`;

let browser;
try {
  browser = await chromium.launch({ executablePath: await findChromium(), headless: true });

  // 1) Normal start: every local asset resolves and the login screen renders.
  const page = await browser.newPage();
  const errors = [], missing = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (res) => { if (res.url().startsWith(base) && res.status() >= 400) missing.push(res.url()); });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    if (url.startsWith(base)) return route.continue();
    const stub = Object.entries(firebaseStubs).find(([name]) => url.startsWith('https://www.gstatic.com/firebasejs/') && url.endsWith('/' + name));
    if (stub) return route.fulfill({ status: 200, contentType: 'text/javascript', headers: { 'Access-Control-Allow-Origin': '*' }, body: stub[1] });
    return route.fulfill({ status: 200, contentType: 'text/css', body: '' }); // fonts
  });
  await page.goto(base);
  await page.getByRole('button', { name: 'Sign in', exact: true }).waitFor({ timeout: 15000 });
  assert.equal(await page.evaluate(() => typeof window.React), 'object');
  assert.equal(await page.evaluate(() => typeof window.XLSX), 'undefined', 'spreadsheet libraries load on demand only');
  const xlsx = await page.evaluate(async () => (await fetch('assets/vendor/xlsx-0.20.3.min.js')).status);
  const exceljs = await page.evaluate(async () => (await fetch('assets/vendor/exceljs-4.4.0.min.js')).status);
  assert.deepEqual([xlsx, exceljs], [200, 200]);
  assert.deepEqual(missing, []);
  assert.deepEqual(errors, []);
  console.log('PASS: dist/ boots to the sign-in screen with all local assets present');

  // 2) Firebase unreachable: a clear error screen with Retry, not a blank page.
  const offline = await browser.newPage();
  await offline.route('**/*', (route) => route.request().url().startsWith(base) ? route.continue() : route.abort());
  await offline.goto(base);
  await offline.getByText('Unable to start', { exact: true }).waitFor({ timeout: 15000 });
  await offline.getByRole('button', { name: 'Retry', exact: true }).waitFor();
  console.log('PASS: dist/ shows a recoverable error when Firebase cannot load');
} finally {
  if (browser) await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
