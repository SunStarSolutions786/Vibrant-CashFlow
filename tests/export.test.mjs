import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { transform } from 'esbuild';
import ExcelJS from 'exceljs';

// Report builders live in JSX page files; compile only the pure helpers used by exports.
async function loadReports() {
  const files = ['config', 'utils', 'masterHelpers', 'components', 'pages/InflowAnalysis', 'pages/OutflowAnalysis', 'pages/ExportReports'];
  const source = files.map((file) => readFileSync(`js/${file}.js`, 'utf8')).join('\n');
  const { code } = await transform(source, { loader: 'jsx', format: 'esm', target: 'es2022' });
  return new Function('window', 'React', 'ReactDOM', `${code}\nreturn { buildOutflowSheet, buildRawDataSheet, MasterHelpers, Utils };`)({}, {}, {});
}

function fixture(rows, verticals = 4, monthCount = 3) {
  const md = { verticals: [], heads: [], subHeads: [], bankAccounts: [] };
  for (let v = 0; v < verticals; v++) {
    md.verticals.push({ id: `v${v}`, name: `Vertical ${v}` });
    for (let h = 0; h < 5; h++) {
      md.heads.push({ id: `h${v}${h}`, verticalId: `v${v}`, name: `Head ${h}`, appliesTo: 'outflow', group: h === 4 ? 'working capital' : 'opex' });
      for (let s = 0; s < 4; s++) md.subHeads.push({ id: `s${v}${h}${s}`, headId: `h${v}${h}`, name: `Sub ${s}` });
    }
  }
  const months = Array.from({ length: monthCount }, (_, i) => `2026-${String(i + 1).padStart(2, '0')}`);
  const txns = Array.from({ length: rows }, (_, i) => {
    const sub = md.subHeads[i % md.subHeads.length];
    const head = md.heads.find((h) => h.id === sub.headId);
    return { id: `t${i}`, date: `${months[i % monthCount]}-${String(1 + (i % 28)).padStart(2, '0')}`, type: 'outflow', status: i % 11 ? 'categorized' : 'uncategorized',
      verticalId: head.verticalId, headId: head.id, subHeadId: sub.id, withdrawal: 100 + (i % 9), deposit: i % 13 === 0 ? 5 : 0 };
  });
  // A historical snapshot with an old label must stay a separate report row.
  txns.push({ id: 'renamed', date: '2026-02-10', type: 'outflow', status: 'categorized', withdrawal: 777, deposit: 0,
    verticalId: 'v0', headId: 'h00', subHeadId: 's000',
    categorySnapshot: { verticalId: 'v0', verticalName: 'Vertical 0', headId: 'h00', headName: 'Head 0', subHeadId: 's000', subHeadName: 'Old name', appliesTo: 'outflow', group: 'opex' } });
  const budgets = months.flatMap((month) => md.subHeads.map((s, i) => ({ id: `${month}${s.id}`, month, subHeadId: s.id, budget: 1000 + i, booking: 400 })));
  return { md, months, txns, budgets };
}

test('OUTFLOW sheet cells equal an independent per-category calculation', async () => {
  const api = await loadReports();
  const { md, months, txns, budgets } = fixture(2400);
  const wb = new ExcelJS.Workbook();
  await api.buildOutflowSheet(wb, md, txns, budgets, months);
  const ws = wb.getWorksheet('OUTFLOW');
  const keyOf = (record) => api.MasterHelpers.snapshotKey(api.MasterHelpers.resolveTransactionChain(md, record));
  const expected = (vertical, head, sub, month) => {
    const matches = (record) => { const c = api.MasterHelpers.resolveTransactionChain(md, record); return c.verticalName === vertical && c.headName === head && c.subHeadName === sub; };
    const planned = budgets.filter((b) => b.month === month && matches(b));
    const paid = txns.filter((t) => t.status === 'categorized' && t.date.startsWith(month) && matches(t)).reduce((sum, t) => sum + t.withdrawal - t.deposit, 0);
    return [planned.reduce((s, b) => s + b.budget, 0), planned.reduce((s, b) => s + b.booking, 0), paid];
  };
  let checked = 0, renamedRow = null;
  for (let r = 3; r < ws.rowCount; r++) {
    const row = ws.getRow(r);
    const [vertical, head, , sub] = [1, 2, 3, 4].map((c) => row.getCell(c).value);
    if (sub === 'Old name') renamedRow = row;
    months.forEach((month, mi) => {
      const actual = [5, 6, 7].map((c) => Number(row.getCell(c + mi * 3).value) || 0);
      assert.deepEqual(actual, expected(vertical, head, sub, month), `${vertical}/${head}/${sub} ${month}`);
      checked++;
    });
  }
  assert.ok(checked >= 80 * months.length);
  assert.ok(renamedRow, 'renamed historical category keeps its own row');
  assert.equal(renamedRow.getCell(10).value, 777);
  assert.equal(new Set(txns.filter((t) => t.status === 'categorized').map(keyOf)).size, 81);
  const total = ws.getRow(ws.rowCount);
  months.forEach((month, mi) => {
    const paid = txns.filter((t) => t.status === 'categorized' && t.date.startsWith(month)).reduce((s, t) => s + t.withdrawal - t.deposit, 0);
    assert.equal(total.getCell(7 + mi * 3).value, paid);
  });
});

test('large OUTFLOW and Raw Data exports finish without per-cell rescans', async () => {
  const api = await loadReports();
  const { md, months, txns, budgets } = fixture(30000, 8, 12);
  const wb = new ExcelJS.Workbook();
  const started = performance.now();
  await api.buildOutflowSheet(wb, md, txns, budgets, months);
  const elapsed = performance.now() - started;
  // The previous implementation needed roughly a minute for this volume.
  assert.ok(elapsed < 8000, `OUTFLOW sheet took ${Math.round(elapsed)} ms`);
  await api.buildRawDataSheet(wb, md, txns, months);
  assert.equal(wb.getWorksheet('Raw Data').rowCount, txns.length + 1);
});
