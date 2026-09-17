import { readFile, writeFile, mkdir, copyFile, rm, access } from 'node:fs/promises';
import { transform } from 'esbuild';
import { createHash } from 'node:crypto';

const sourceFiles = [
  'js/config.js',
  'js/utils.js',
  'js/masterHelpers.js',
  'js/firebaseRepository.js',
  'js/userProvisioning.js',
  'js/localStore.js',
  'js/firebaseClient.js',
  'js/dataStore.js',
  'js/auth.js',
  'js/components.js',
  'js/pages/Login.js',
  'js/pages/Dashboard.js',
  'js/pages/UploadStatement.js',
  'js/pages/CashEntry.js',
  'js/pages/TransactionEditor.js',
  'js/pages/Categorize.js',
  'js/pages/InflowAnalysis.js',
  'js/pages/OutflowAnalysis.js',
  'js/pages/BudgetBooking.js',
  'js/pages/MasterData.js',
  'js/pages/Users.js',
  'js/pages/ExportReports.js',
  'js/app.js',
];

// dist/ is the only deployable output. Rebuild it from scratch so files from
// an older build can never be published by mistake.
const vendorSources = ['react', 'react-dom', 'xlsx', 'exceljs'];
for (const name of vendorSources) {
  try { await access('node_modules/' + name + '/package.json'); }
  catch { throw new Error(`Missing node_modules/${name}. Run "npm install" before "npm run build".`); }
}
await rm('dist', { recursive: true, force: true });

const parts = await Promise.all(sourceFiles.map(async (file) => `\n/* ${file} */\n${await readFile(file, 'utf8')}`));
const result = await transform(parts.join('\n'), {
  loader: 'jsx',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
});

await mkdir('dist/js', { recursive: true });
await mkdir('dist/assets/vendor', { recursive: true });
await writeFile('dist/js/app.bundle.min.js', `${result.code}\n`, 'utf8');
const version = createHash('sha256').update(result.code).digest('hex').slice(0, 12);
const cssVersion = createHash('sha256').update(await readFile('styles.css')).digest('hex').slice(0, 12);
const html = (await readFile('index.html', 'utf8'))
  .replace(/<!-- Source template[^>]*-->\r?\n/, '')
  .replace(/src="js\/app\.bundle\.min\.js(?:\?v=[^"]*)?"/, `src="js/app.bundle.min.js?v=${version}"`)
  .replace(/href="styles\.css(?:\?v=[^"]*)?"/, `href="styles.css?v=${cssVersion}"`);
await writeFile('dist/index.html', html, 'utf8');
await copyFile('styles.css', 'dist/styles.css');
await copyFile('assets/vibrant-logo.png', 'dist/assets/vibrant-logo.png');
// GitHub Pages: serve files as-is (no Jekyll processing).
await writeFile('dist/.nojekyll', '');
// Cloudflare Pages / Netlify read this file; other hosts ignore it.
await writeFile('dist/_headers', [
  '/index.html', '  Cache-Control: no-cache', '',
  '/', '  Cache-Control: no-cache', '',
  '/assets/vendor/*', '  Cache-Control: public, max-age=31536000, immutable', '',
  '/js/*', '  Cache-Control: public, max-age=3600', '',
  '/*', '  X-Content-Type-Options: nosniff', '  Referrer-Policy: strict-origin-when-cross-origin', '',
].join('\n'));
const vendors = [
  ['react/umd/react.production.min.js', 'react-18.3.1.min.js'],
  ['react-dom/umd/react-dom.production.min.js', 'react-dom-18.3.1.min.js'],
  ['xlsx/dist/xlsx.full.min.js', 'xlsx-0.20.3.min.js'],
  ['exceljs/dist/exceljs.min.js', 'exceljs-4.4.0.min.js'],
];
await Promise.all(vendors.map(([source, target]) => copyFile('node_modules/' + source, 'dist/assets/vendor/' + target)));
const licenses = await Promise.all(vendorSources.map(async (name) => name + '\n' + await readFile('node_modules/' + name + '/LICENSE', 'utf8')));
await writeFile('dist/assets/vendor/LICENSES.txt', licenses.join('\n\n'));
console.log(`Built dist/js/app.bundle.min.js (${Buffer.byteLength(result.code).toLocaleString()} bytes)`);
