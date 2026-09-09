import { readFile, writeFile } from 'node:fs/promises';
import { transform } from 'esbuild';

const sourceFiles = [
  'js/config.js',
  'js/firebaseClient.js',
  'js/utils.js',
  'js/masterHelpers.js',
  'js/dataStore.js',
  'js/auth.js',
  'js/components.js',
  'js/pages/Login.js',
  'js/pages/Dashboard.js',
  'js/pages/UploadStatement.js',
  'js/pages/CashEntry.js',
  'js/pages/Categorize.js',
  'js/pages/InflowAnalysis.js',
  'js/pages/OutflowAnalysis.js',
  'js/pages/BudgetBooking.js',
  'js/pages/MasterData.js',
  'js/pages/Users.js',
  'js/pages/ExportReports.js',
  'js/app.js',
];

const parts = await Promise.all(sourceFiles.map(async (file) => `\n/* ${file} */\n${await readFile(file, 'utf8')}`));
const result = await transform(parts.join('\n'), {
  loader: 'jsx',
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
});

await writeFile('js/app.bundle.min.js', `${result.code}\n`, 'utf8');
console.log(`Built js/app.bundle.min.js (${Buffer.byteLength(result.code).toLocaleString()} bytes)`);
