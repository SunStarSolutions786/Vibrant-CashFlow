// ============================================================================
// VIBRANT CashFlow — Export Reports
// Builds a colour-coded .xlsx (INFLOW + OUTFLOW sheets) with ExcelJS, shaped
// like the reference "Monthly summary" workbook.
// ============================================================================

const VERTICAL_PALETTE = ['4338CA', '0D9488', 'D97706', '2563EB', 'DB2777', '65A30D'];

function daysInMonth(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function fillArgb(hex) { return { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + hex } }; }
function tint(hex, amt) {
  const n = parseInt(hex, 16);
  const r = Math.min(255, ((n >> 16) & 255) + amt), g = Math.min(255, ((n >> 8) & 255) + amt), b = Math.min(255, (n & 255) + amt);
  return [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// Shared by INFLOW, Internal Transfer and Working Capital: pivoted at
// Sub-head level (not Head) so each party — INFINIX, NOKIA, DISH, etc. — is
// its own column, grouped under a merged Vertical header band, with a
// "Total" column closing out every vertical's block plus one Grand Total at
// the end. Every day of every month gets a row — zero where there's no
// activity — so a month's figures always add up whether or not something
// happened on a given day.
function buildPivotSheet(wb, sheetName, vGroups, txns, valueFn, months, masterData) {
  const ws = wb.addWorksheet(sheetName);

  // LEAD_COLS: A = spacer, B = Date, C = row-label column ("Vertical" / "Sub-head").
  const LEAD_COLS = 3;
  const plan = []; // flat, in column order: {type:'sub'|'total', subHeadId?, name, color, groupSubIds?}
  const vBands = []; // {name, color, startCol, endCol} for the row-1 merge
  let col = LEAD_COLS + 1;
  vGroups.forEach((g) => {
    const startCol = col;
    g.subHeads.forEach((s) => { plan.push({ type: 'sub', key: s.key, name: s.name, color: g.color }); col++; });
    plan.push({ type: 'total', name: 'Total', color: g.color, groupSubKeys: g.subHeads.map((s) => s.key) });
    col++;
    vBands.push({ name: g.vertical.name, color: g.color, startCol, endCol: col - 1 });
  });
  const grandTotalCol = col;

  ws.columns = [{ width: 3 }, { width: 12 }, { width: 13 }, ...plan.map((p) => ({ width: p.type === 'total' ? 14 : 13 })), { width: 15 }];

  let r = 1;
  ws.getCell(r, 3).value = 'Vertical'; ws.getCell(r, 3).font = { bold: true };
  vBands.forEach((b) => {
    ws.mergeCells(r, b.startCol, r, b.endCol);
    const cell = ws.getCell(r, b.startCol);
    cell.value = b.name; cell.fill = fillArgb(b.color); cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
  });
  r++;
  ws.getCell(r, 2).value = 'Date';
  ws.getCell(r, 3).value = 'Sub-head';
  plan.forEach((p, i) => {
    const cell = ws.getCell(r, LEAD_COLS + 1 + i);
    cell.value = p.name;
    cell.fill = fillArgb(p.type === 'total' ? tint(p.color, 90) : tint(p.color, 150));
    cell.font = { bold: true, color: p.type === 'total' ? { argb: 'FFFFFFFF' } : undefined };
  });
  ws.getCell(r, grandTotalCol).value = 'Grand Total';
  ws.getRow(r).eachCell((c) => { c.font = Object.assign({}, c.font, { bold: true }); c.border = { bottom: { style: 'thin' } }; });
  r++;

  months.forEach((m) => {
    const monthTxns = txns.filter((t) => Utils.monthKey(t.date) === m)
      .map((t) => ({ txn: t, key: MasterHelpers.snapshotKey(MasterHelpers.resolveTransactionChain(masterData, t)) }));
    const dCount = daysInMonth(m);
    const colTotals = new Array(plan.length).fill(0);
    let monthGrand = 0;

    for (let d = 1; d <= dCount; d++) {
      const iso = `${m}-${String(d).padStart(2, '0')}`;
      const dayTxns = monthTxns.filter((entry) => entry.txn.date === iso);
      ws.getCell(r, 2).value = Utils.formatDate(iso);
      const subValues = {}; // snapshot key -> amount, for this row
      let rowGrand = 0;
      plan.forEach((p, i) => {
        const cellCol = LEAD_COLS + 1 + i;
        let value;
        if (p.type === 'sub') {
          value = Utils.sumBy(dayTxns.filter((entry) => entry.key === p.key), (entry) => valueFn(entry.txn));
          subValues[p.key] = value;
        } else {
          value = Utils.sumBy(p.groupSubKeys, (key) => subValues[key] || 0);
          rowGrand += value;
        }
        ws.getCell(r, cellCol).value = value; ws.getCell(r, cellCol).numFmt = '#,##0';
        if (p.type === 'total') { ws.getCell(r, cellCol).font = { bold: true }; ws.getCell(r, cellCol).fill = fillArgb(tint(p.color, 195)); }
        colTotals[i] += value;
      });
      ws.getCell(r, grandTotalCol).value = rowGrand; ws.getCell(r, grandTotalCol).numFmt = '#,##0'; ws.getCell(r, grandTotalCol).font = { bold: true };
      monthGrand += rowGrand;
      r++;
    }

    ws.getCell(r, 2).value = `${Utils.monthLabel(m)} — Monthly Total`;
    plan.forEach((p, i) => { const cell = ws.getCell(r, LEAD_COLS + 1 + i); cell.value = colTotals[i] || 0; cell.numFmt = '#,##0'; });
    ws.getCell(r, grandTotalCol).value = monthGrand; ws.getCell(r, grandTotalCol).numFmt = '#,##0';
    ws.getRow(r).eachCell((c) => { c.font = { bold: true }; c.fill = fillArgb('EEF0F7'); });
    r += 2;
  });

  ws.views = [{ state: 'frozen', xSplit: LEAD_COLS, ySplit: 2 }];
}

function collectReportCategories(masterData, records, headPredicate) {
  const categories = new Map();
  function add(chain, preferSnapshot) {
    const key = MasterHelpers.snapshotKey(chain);
    if (!key) return;
    if (!categories.has(key) || preferSnapshot) categories.set(key, { key, chain });
  }
  (masterData.heads || []).filter(headPredicate).forEach((head) => {
    const vertical = (masterData.verticals || []).find((v) => v.id === head.verticalId);
    (masterData.subHeads || []).filter((s) => s.headId === head.id).forEach((sub) => add({
      verticalId: vertical ? vertical.id : head.verticalId,
      verticalName: vertical ? vertical.name : '',
      headId: head.id,
      headName: head.name,
      subHeadId: sub.id,
      subHeadName: sub.name,
      appliesTo: head.appliesTo,
      group: head.group || '',
    }, false));
  });
  (records || []).forEach((record) => add(MasterHelpers.resolveTransactionChain(masterData, record), Boolean(record.categorySnapshot)));
  return Array.from(categories.values());
}

// Groups snapshot-backed category rows by Vertical, retaining categories that
// have since been renamed or removed from current master data.
function groupReportCategories(categories) {
  const groups = new Map();
  categories.forEach(({ key, chain }) => {
    const verticalKey = reportVerticalKey(chain) || 'unassigned';
    if (!groups.has(verticalKey)) groups.set(verticalKey, {
      vertical: { id: chain.verticalId || verticalKey, name: chain.verticalName || 'Unassigned' },
      subHeads: [],
    });
    groups.get(verticalKey).subHeads.push({ key, id: chain.subHeadId, name: chain.subHeadName || 'Unassigned' });
  });
  return Array.from(groups.values())
    .sort((a, b) => a.vertical.name.localeCompare(b.vertical.name))
    .map((g, gi) => ({ ...g, color: VERTICAL_PALETTE[gi % VERTICAL_PALETTE.length] }));
}

// Only strictly-inflow heads — Internal Transfer / Loan heads (appliesTo
// "both") get their own sheet below, not mixed in here.
async function buildInflowSheet(wb, masterData, txns, months) {
  const relevant = txns.filter((t) => t.type === TXN_TYPE.INFLOW && t.status === TXN_STATUS.CATEGORIZED);
  const vGroups = groupReportCategories(collectReportCategories(masterData, relevant, (h) => h.appliesTo === 'inflow'));
  buildPivotSheet(wb, 'INFLOW', vGroups, relevant, Utils.netCash, months, masterData);
}

// Money moved between the group's own accounts — tracked separately so it
// never inflates Inflow/Outflow totals. Group "internal" is the only one
// ever set on a "both"-flow head, so this alone identifies them.
async function buildInternalTransferSheet(wb, masterData, txns, months) {
  const relevant = txns.filter((t) => t.type === TXN_TYPE.INTERNAL && t.status === TXN_STATUS.CATEGORIZED);
  const vGroups = groupReportCategories(collectReportCategories(masterData, relevant, (h) => h.group === 'internal'));
  if (vGroups.length === 0) return;
  buildPivotSheet(wb, 'Internal Transfer', vGroups, relevant, Utils.netCash, months, masterData);
}

// Purchase / stock-in spend (Group = "working capital") — its own sheet, kept
// out of the OUTFLOW sheet below which is Capex/Opex spend only.
async function buildWorkingCapitalSheet(wb, masterData, txns, months) {
  const relevant = txns.filter((t) => t.type === TXN_TYPE.OUTFLOW && t.status === TXN_STATUS.CATEGORIZED
    && MasterHelpers.resolveTransactionChain(masterData, t).group === 'working capital');
  const vGroups = groupReportCategories(collectReportCategories(masterData, relevant, (h) => h.group === 'working capital'));
  if (vGroups.length === 0) return;
  buildPivotSheet(wb, 'Working Capital', vGroups, relevant, Utils.netOutflow, months, masterData);
}

async function buildOutflowSheet(wb, masterData, txns, budgets, months) {
  const ws = wb.addWorksheet('OUTFLOW');
  // Detailed outflow is the reconciliation source: Capex, Opex and Working
  // Capital all appear here with Budget / Booking / net Paid values.
  const relevantTxns = txns.filter((t) => t.type === TXN_TYPE.OUTFLOW && t.status === TXN_STATUS.CATEGORIZED);
  const categories = collectOutflowCategories(masterData, relevantTxns, budgets)
    .sort((a, b) => {
      const ac = a.chain, bc = b.chain;
      return `${ac.verticalName}|${ac.headName}|${ac.subHeadName}`.localeCompare(`${bc.verticalName}|${bc.headName}|${bc.subHeadName}`);
    });
  const verticalColors = new Map();
  categories.forEach(({ chain }) => {
    const key = reportVerticalKey(chain) || 'unassigned';
    if (!verticalColors.has(key)) verticalColors.set(key, VERTICAL_PALETTE[verticalColors.size % VERTICAL_PALETTE.length]);
  });
  const LEAD_COLS = 4; // Vertical, Head, Group, Sub-head
  ws.columns = [{ width: 14 }, { width: 20 }, { width: 10 }, { width: 26 },
    ...months.flatMap(() => [{ width: 13 }, { width: 13 }, { width: 13 }])];

  let r = 1;
  ws.getCell(r, 1).value = 'Vertical'; ws.getCell(r, 2).value = 'Head'; ws.getCell(r, 3).value = 'Group'; ws.getCell(r, 4).value = 'Sub-head';
  months.forEach((m, mi) => {
    const startCol = LEAD_COLS + 1 + mi * 3;
    ws.mergeCells(r, startCol, r, startCol + 2);
    const cell = ws.getCell(r, startCol);
    cell.value = Utils.monthLabel(m); cell.fill = fillArgb('12162B'); cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center' };
  });
  ws.getRow(r).eachCell((c) => { c.font = Object.assign({}, c.font, { bold: true }); });
  r++;
  ws.getCell(r, 1).value = ''; ws.getCell(r, 2).value = ''; ws.getCell(r, 3).value = ''; ws.getCell(r, 4).value = '';
  months.forEach((m, mi) => {
    const startCol = LEAD_COLS + 1 + mi * 3;
    ['Budget', 'Booking', 'Paid'].forEach((lbl, i) => { const c = ws.getCell(r, startCol + i); c.value = lbl; c.font = { bold: true }; c.fill = fillArgb('F0F1F6'); });
  });
  r++;
  const headerRowCount = r - 1;

  const grandTotals = months.map(() => ({ budget: 0, booking: 0, paid: 0 }));

  categories.forEach(({ key, chain }) => {
        const vColor = verticalColors.get(reportVerticalKey(chain) || 'unassigned');
        ws.getCell(r, 1).value = chain.verticalName || 'Unassigned';
        ws.getCell(r, 2).value = chain.headName || 'Unassigned';
        ws.getCell(r, 3).value = chain.group || 'opex';
        ws.getCell(r, 4).value = chain.subHeadName || 'Unassigned';
        ws.getCell(r, 1).fill = fillArgb(tint(vColor, 170));
        months.forEach((m, mi) => {
          const matchingBudgets = budgets.filter((b) => b.month === m && MasterHelpers.snapshotKey(MasterHelpers.resolveTransactionChain(masterData, b)) === key);
          const budget = Utils.sumBy(matchingBudgets, (b) => b.budget);
          const booking = Utils.sumBy(matchingBudgets, (b) => b.booking);
          const paid = Utils.sumBy(relevantTxns.filter((t) => Utils.monthKey(t.date) === m
            && MasterHelpers.snapshotKey(MasterHelpers.resolveTransactionChain(masterData, t)) === key), Utils.netOutflow);
          grandTotals[mi].budget += budget; grandTotals[mi].booking += booking; grandTotals[mi].paid += paid;
          const startCol = LEAD_COLS + 1 + mi * 3;
          ws.getCell(r, startCol).value = budget || '';
          ws.getCell(r, startCol + 1).value = booking || '';
          const paidCell = ws.getCell(r, startCol + 2);
          paidCell.value = paid || '';
          const tone = varianceTone(budget, paid);
          const bg = tone === 'over' ? 'FDECEB' : tone === 'near' ? 'FEF3E0' : 'E9F9EE';
          const fg = tone === 'over' ? 'B91C1C' : tone === 'near' ? 'B45309' : '15803D';
          paidCell.fill = fillArgb(bg); paidCell.font = { color: { argb: 'FF' + fg }, bold: true };
          [startCol, startCol + 1, startCol + 2].forEach((c) => { ws.getCell(r, c).numFmt = '#,##0'; });
        });
        r++;
  });

  ws.getCell(r, 1).value = 'Grand Total';
  months.forEach((m, mi) => {
    const startCol = LEAD_COLS + 1 + mi * 3;
    ws.getCell(r, startCol).value = grandTotals[mi].budget;
    ws.getCell(r, startCol + 1).value = grandTotals[mi].booking;
    ws.getCell(r, startCol + 2).value = grandTotals[mi].paid;
    [startCol, startCol + 1, startCol + 2].forEach((c) => { ws.getCell(r, c).numFmt = '#,##0'; });
  });
  ws.getRow(r).eachCell((c) => { c.font = { bold: true }; c.fill = fillArgb('EEF0F7'); c.border = { top: { style: 'thin' } }; });

  ws.views = [{ state: 'frozen', xSplit: LEAD_COLS, ySplit: headerRowCount }];
}

// Flat, transaction-level dump (with master-data labels resolved) alongside
// the pivoted report sheets, for audit / cross-checking against the source.
async function buildRawDataSheet(wb, masterData, txns, months) {
  const ws = wb.addWorksheet('Raw Data');
  const headers = ['Date', 'Source', 'Bank Account', 'Type', 'Vertical', 'Head', 'Flow', 'Group', 'Sub-head', 'Particulars', 'Particulars2', 'Remarks', 'Withdrawal', 'Deposit', 'Status'];
  ws.columns = headers.map((h) => ({ header: h, width: Math.max(12, h.length + 4) }));
  ws.getRow(1).eachCell((c) => { c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = fillArgb('12162B'); });

  const rows = txns.filter((t) => months.includes(Utils.monthKey(t.date))).sort((a, b) => a.date.localeCompare(b.date));
  rows.forEach((t, i) => {
    const chain = MasterHelpers.resolveTransactionChain(masterData, t);
    const r = i + 2; // row 1 is the header
    const values = [
      Utils.formatDate(t.date), t.source,
      (t.bankSnapshot && t.bankSnapshot.name) || t.bankName || MasterHelpers.bankAccountName(masterData, t.bankAccountId), t.type,
      chain.verticalName, chain.headName, chain.appliesTo || '', chain.group || '', chain.subHeadName,
      t.particulars, t.particulars2, t.remarksBank,
      t.withdrawal || '', t.deposit || '', t.status,
    ];
    values.forEach((v, ci) => { ws.getCell(r, ci + 1).value = v; });
  });
  ws.getColumn(13).numFmt = '#,##0'; ws.getColumn(14).numFmt = '#,##0';
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, rows.length + 1), column: headers.length } };
}

function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// Builds a self-contained, multi-page HTML analysis report — its own sidebar
// navigation between Overview / Inflow / Outflow / Internal Transfers pages,
// colour-coded like the app itself. No external assets, opens/prints offline.
function buildHtmlReport(masterData, txns, budgets, months, logoDataUrl) {
  const inflow = txns.filter((t) => t.type === TXN_TYPE.INFLOW && t.status === TXN_STATUS.CATEGORIZED && months.includes(Utils.monthKey(t.date)));
  const outflow = txns.filter((t) => t.type === TXN_TYPE.OUTFLOW && t.status === TXN_STATUS.CATEGORIZED && months.includes(Utils.monthKey(t.date)));
  const internal = txns.filter((t) => t.type === TXN_TYPE.INTERNAL && t.status === TXN_STATUS.CATEGORIZED && months.includes(Utils.monthKey(t.date)));
  const totalInflow = Utils.sumBy(inflow, Utils.netCash);
  const totalOutflow = Utils.sumBy(outflow, Utils.netOutflow);
  const uncategorized = txns.filter((t) => t.status === TXN_STATUS.UNCATEGORIZED && months.includes(Utils.monthKey(t.date))).length;

  function groupInflow(level) {
    const grouped = new Map();
    inflow.forEach((txn) => {
      const chain = MasterHelpers.resolveTransactionChain(masterData, txn);
      const keyedChain = level === 'head' ? { ...chain, subHeadId: '', subHeadName: '' } : chain;
      const key = MasterHelpers.snapshotKey(keyedChain) || `unassigned:${level}`;
      if (!grouped.has(key)) grouped.set(key, { chain, list: [] });
      grouped.get(key).list.push(txn);
    });
    return Array.from(grouped.values());
  }
  const inflowHeadRows = groupInflow('head').map(({ chain, list }) => ({
    name: chain.headName || 'Unassigned', vertical: chain.verticalName || 'Unassigned',
    total: Utils.sumBy(list, Utils.netCash),
  })).sort((a, b) => b.total - a.total);
  const maxInflowHead = Math.max(1, ...inflowHeadRows.map((r) => Math.abs(r.total)));

  const inflowSubRows = groupInflow('sub').map(({ chain, list }) => ({
    name: chain.subHeadName || 'Unassigned', head: chain.headName || 'Unassigned',
    total: Utils.sumBy(list, Utils.netCash), count: list.length,
  })).sort((a, b) => b.total - a.total);

  const byDate = Utils.groupBy(inflow, (t) => t.date);
  const dateRows = Object.entries(byDate).map(([date, list]) => ({ date, total: Utils.sumBy(list, Utils.netCash) })).sort((a, b) => b.date.localeCompare(a.date));

  const outflowRows = outflowRowsForMonths(masterData, txns, budgets, months)
    .filter((row) => row.budget !== 0 || row.booking !== 0 || row.paid !== 0)
    .sort((a, b) => `${a.vertical}|${a.head}|${a.sub}`.localeCompare(`${b.vertical}|${b.head}|${b.sub}`));
  const grandBudget = Utils.sumBy(outflowRows, (row) => row.budget);
  const grandBooking = Utils.sumBy(outflowRows, (row) => row.booking);
  const grandPaid = Utils.sumBy(outflowRows, (row) => row.paid);
  const overBudgetRows = outflowRows.filter((r) => r.tone === 'over').sort((a, b) => (b.paid - b.budget) - (a.paid - a.budget));

  const fmt = (n) => Utils.formatCurrency(n);
  const monthLabel = months.length ? `${Utils.monthLabel(months[0])} – ${Utils.monthLabel(months[months.length - 1])}` : '';
  const toneBadge = (tone) => `<span class="pill ${tone}">${tone === 'over' ? 'Over Budget' : tone === 'near' ? 'Near Limit' : 'Under Budget'}</span>`;

  const navItems = [
    { id: 'overview', icon: '&#127968;', label: 'Overview' },
    { id: 'inflow', icon: '&#128200;', label: 'Inflow Analysis' },
    { id: 'outflow', icon: '&#128201;', label: 'Outflow Analysis' },
  ];
  if (internal.length > 0) navItems.push({ id: 'internal', icon: '&#128260;', label: `Internal Transfers (${internal.length})` });

  const reportLogo = logoDataUrl || BRAND_LOGO_PATH;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(APP_NAME)} Analysis</title>
<style>
:root{
  --primary:#4338ca;--primary-light:#eceafd;--accent:#0d9488;--text:#1b2333;--muted:#6b7590;--faint:#98a2b8;
  --border:#e4e8f1;--surface:#fff;--surface-alt:#f8f9fc;--bg:#f4f6fb;
  --success:#16a34a;--success-bg:#e9f9ee;--warning:#d97706;--warning-bg:#fef3e0;--danger:#dc2626;--danger-bg:#fdeceb;
  --sidebar:#12162b;--sidebar-alt:#1a1f3a;
}
*{box-sizing:border-box;}
body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,Arial,sans-serif;color:var(--text);background:var(--bg);}
.shell{display:flex;min-height:100vh;}
.sidebar{width:236px;flex-shrink:0;background:linear-gradient(180deg,var(--sidebar),var(--sidebar-alt));color:#b7bdd6;padding:22px 14px;}
.brand{display:flex;align-items:center;gap:10px;padding:0 8px 22px;}
.brand-logo{display:block;width:74px;height:auto;background:#fff;border-radius:7px;padding:3px 5px;flex-shrink:0;}
.brand-text b{display:block;color:#fff;font-size:13.5px;line-height:1.3;}
.brand-text span{font-size:10px;opacity:.7;}
.nav-item{display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;margin-bottom:2px;transition:background .15s;}
.nav-item:hover{background:rgba(255,255,255,.06);color:#fff;}
.nav-item.active{background:rgba(124,108,242,.2);color:#fff;box-shadow:inset 2px 0 0 var(--accent);}
.main{flex:1;min-width:0;}
.topbar{background:var(--surface);border-bottom:1px solid var(--border);padding:18px 32px;}
.topbar h1{font-size:19px;margin:0 0 2px;}
.topbar .sub{color:var(--muted);font-size:12.5px;}
.content{padding:28px 32px;max-width:1200px;}
.page{display:none;}
.page.active{display:block;animation:fadeIn .25s ease;}
@keyframes fadeIn{from{opacity:0;transform:translateY(6px);}to{opacity:1;transform:translateY(0);}}
.card{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px;margin-bottom:20px;box-shadow:0 1px 2px rgba(20,24,45,.05);}
.card h2{font-size:14.5px;margin:0 0 3px;}
.card .card-sub{color:var(--muted);font-size:12px;margin:0 0 16px;}
.stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:20px;}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:16px 18px;}
.stat .label{font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.03em;margin-bottom:8px;}
.stat .value{font-size:21px;font-weight:800;letter-spacing:-.3px;}
table{width:100%;border-collapse:collapse;font-size:12.5px;}
th{text-align:left;padding:9px 12px;background:var(--surface-alt);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);border-bottom:1px solid var(--border);}
td{padding:9px 12px;border-bottom:1px solid var(--border);}
tr:last-child td{border-bottom:none;}
.num{text-align:right;font-variant-numeric:tabular-nums;}
.table-wrap{overflow-x:auto;border:1px solid var(--border);border-radius:12px;}
.table-wrap table{min-width:520px;}
.under{background:var(--success-bg);color:var(--success);font-weight:700;}
.near{background:var(--warning-bg);color:var(--warning);font-weight:700;}
.over{background:var(--danger-bg);color:var(--danger);font-weight:700;}
.pill{display:inline-block;padding:3px 9px;border-radius:999px;font-size:10.5px;font-weight:700;}
.pill.under{background:var(--success-bg);color:var(--success);}
.pill.near{background:var(--warning-bg);color:var(--warning);}
.pill.over{background:var(--danger-bg);color:var(--danger);}
.bar-row{margin-bottom:13px;}
.bar-label{display:flex;justify-content:space-between;font-size:12.5px;margin-bottom:5px;}
.bar-track{height:7px;border-radius:999px;background:var(--surface-alt);overflow:hidden;}
.bar-fill{height:100%;border-radius:999px;background:var(--accent);}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:20px;}
@media (max-width:800px){.two-col{grid-template-columns:1fr;} .shell{flex-direction:column;} .sidebar{width:100%;display:flex;align-items:center;gap:4px;overflow-x:auto;padding:12px;} .brand{padding:0 10px 0 0;} .nav-item{white-space:nowrap;}}
@media print{.sidebar{display:none;} .main{width:100%;} .page{display:block !important;break-after:page;} .card{box-shadow:none;break-inside:avoid;}}
</style></head>
<body>
<div class="shell">
  <aside class="sidebar">
    <div class="brand"><img class="brand-logo" src="${escapeHtml(reportLogo)}" alt="VIBRANT"><div class="brand-text"><b>${escapeHtml(APP_NAME)}</b><span>Analysis Report</span></div></div>
    <nav>
      ${navItems.map((n, i) => `<div class="nav-item${i === 0 ? ' active' : ''}" data-page="${n.id}" onclick="vcfShowPage('${n.id}')"><span>${n.icon}</span><span>${escapeHtml(n.label)}</span></div>`).join('')}
    </nav>
  </aside>
  <div class="main">
    <div class="topbar">
      <h1>Cash Flow Analysis</h1>
      <div class="sub">${escapeHtml(monthLabel)} &middot; generated ${escapeHtml(Utils.formatDate(Utils.todayISO()))}</div>
    </div>
    <div class="content">

      <section class="page active" id="page-overview">
        <div class="stat-grid">
          <div class="stat"><div class="label">Total Inflow</div><div class="value">${fmt(totalInflow)}</div></div>
          <div class="stat"><div class="label">Total Outflow</div><div class="value">${fmt(totalOutflow)}</div></div>
          <div class="stat"><div class="label">Net Position</div><div class="value">${fmt(totalInflow - totalOutflow)}</div></div>
          <div class="stat"><div class="label">Budget vs Paid</div><div class="value">${fmt(grandBudget)} / ${fmt(grandPaid)}</div></div>
        </div>
        <div class="two-col">
          <div class="card">
            <h2>Top Inflow Heads</h2><p class="card-sub">Highest-collecting classification heads</p>
            ${inflowHeadRows.slice(0, 6).map((r) => `<div class="bar-row"><div class="bar-label"><span><b>${escapeHtml(r.name)}</b> &middot; ${escapeHtml(r.vertical)}</span><span>${fmt(r.total)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.round((Math.abs(r.total) / maxInflowHead) * 100)}%;background:${r.total < 0 ? 'var(--danger)' : 'var(--accent)'}"></div></div></div>`).join('') || '<p class="card-sub">No categorized inflow in this range.</p>'}
          </div>
          <div class="card">
            <h2>Over-Budget Sub-heads</h2><p class="card-sub">Highest overspend against budget this range</p>
            ${overBudgetRows.length === 0 ? '<p class="card-sub">Nothing over budget — everything is on track.</p>' : `
            <div class="table-wrap"><table><thead><tr><th>Sub-head</th><th>Vertical</th><th class="num">Over by</th></tr></thead><tbody>
            ${overBudgetRows.slice(0, 6).map((r) => `<tr><td>${escapeHtml(r.sub)}</td><td>${escapeHtml(r.vertical)}</td><td class="num over">${fmt(r.paid - r.budget)}</td></tr>`).join('')}
            </tbody></table></div>`}
          </div>
        </div>
        ${uncategorized > 0 ? `<div class="card"><h2>&#9888; ${uncategorized} uncategorized entr${uncategorized === 1 ? 'y' : 'ies'}</h2><p class="card-sub" style="margin:0;">Not included in the totals above — categorize them in the app for a complete picture.</p></div>` : ''}
      </section>

      <section class="page" id="page-inflow">
        <div class="card">
          <h2>Inflow by Head</h2><p class="card-sub">Share of total collection by classification head</p>
          ${inflowHeadRows.map((r) => `<div class="bar-row"><div class="bar-label"><span><b>${escapeHtml(r.name)}</b> <span style="color:var(--muted)">&middot; ${escapeHtml(r.vertical)}</span></span><span>${fmt(r.total)}</span></div><div class="bar-track"><div class="bar-fill" style="width:${Math.round((Math.abs(r.total) / maxInflowHead) * 100)}%;background:${r.total < 0 ? 'var(--danger)' : 'var(--accent)'}"></div></div></div>`).join('') || '<p class="card-sub">No categorized inflow in this range.</p>'}
        </div>
        <div class="card">
          <h2>Head / Sub-head breakdown</h2>
          <div class="table-wrap"><table><thead><tr><th>Head</th><th>Sub-head</th><th class="num">Entries</th><th class="num">Total</th></tr></thead><tbody>
          ${inflowSubRows.map((r) => `<tr><td>${escapeHtml(r.head)}</td><td>${escapeHtml(r.name)}</td><td class="num">${r.count}</td><td class="num">${fmt(r.total)}</td></tr>`).join('')}
          <tr><td colspan="3"><b>Total</b></td><td class="num"><b>${fmt(totalInflow)}</b></td></tr>
          </tbody></table></div>
        </div>
        <div class="card">
          <h2>Day-wise Collection</h2>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th class="num">Total</th></tr></thead><tbody>
          ${dateRows.map((r) => `<tr><td>${escapeHtml(Utils.formatDate(r.date))}</td><td class="num">${fmt(r.total)}</td></tr>`).join('')}
          </tbody></table></div>
        </div>
      </section>

      <section class="page" id="page-outflow">
        <div class="stat-grid">
          <div class="stat"><div class="label">Budget</div><div class="value">${fmt(grandBudget)}</div></div>
          <div class="stat"><div class="label">Booking</div><div class="value">${fmt(grandBooking)}</div></div>
          <div class="stat"><div class="label">Actual Paid</div><div class="value">${fmt(grandPaid)}</div></div>
          <div class="stat"><div class="label">Variance</div><div class="value">${fmt(grandBudget - grandPaid)}</div></div>
        </div>
        <div class="card">
          <h2>Outflow &mdash; Budget vs Booking vs Paid</h2><p class="card-sub">Colour-coded by spend against budget: green = under, amber = near limit, red = over</p>
          <div class="table-wrap"><table><thead><tr><th>Vertical</th><th>Head</th><th>Group</th><th>Sub-head</th><th class="num">Budget</th><th class="num">Booking</th><th class="num">Paid</th><th>Status</th></tr></thead><tbody>
          ${outflowRows.map((r) => `<tr class="${r.tone}"><td>${escapeHtml(r.vertical)}</td><td>${escapeHtml(r.head)}</td><td>${r.group ? `<span class="pill" style="background:var(--surface-alt);color:var(--muted);">${escapeHtml(r.group)}</span>` : ''}</td><td>${escapeHtml(r.sub)}</td><td class="num">${fmt(r.budget)}</td><td class="num">${fmt(r.booking)}</td><td class="num ${r.tone}">${fmt(r.paid)}</td><td>${toneBadge(r.tone)}</td></tr>`).join('') || '<tr><td colspan="8" style="color:var(--muted);text-align:center;">No budget or spend recorded for this range.</td></tr>'}
          <tr><td colspan="4"><b>Total</b></td><td class="num"><b>${fmt(grandBudget)}</b></td><td class="num"><b>${fmt(grandBooking)}</b></td><td class="num"><b>${fmt(grandPaid)}</b></td><td></td></tr>
          </tbody></table></div>
        </div>
      </section>

      ${internal.length > 0 ? `
      <section class="page" id="page-internal">
        <div class="card">
          <h2>Internal Transfers</h2><p class="card-sub">Moved between group accounts &mdash; excluded from Inflow / Outflow totals</p>
          <div class="table-wrap"><table><thead><tr><th>Date</th><th>Particulars</th><th>Vertical / Head</th><th class="num">Amount</th></tr></thead><tbody>
          ${internal.map((t) => { const chain = MasterHelpers.resolveTransactionChain(masterData, t); return `<tr><td>${escapeHtml(Utils.formatDate(t.date))}</td><td>${escapeHtml(t.particulars || t.remarksBank)}</td><td>${escapeHtml(chain.verticalName)} / ${escapeHtml(chain.headName)}</td><td class="num">${fmt(Utils.netCash(t))}</td></tr>`; }).join('')}
          </tbody></table></div>
        </div>
      </section>` : ''}

    </div>
  </div>
</div>
<script>
function vcfShowPage(id){
  document.querySelectorAll('.page').forEach(function(el){ el.classList.toggle('active', el.id === 'page-' + id); });
  document.querySelectorAll('.nav-item').forEach(function(el){ el.classList.toggle('active', el.getAttribute('data-page') === id); });
}
</script>
</body></html>`;
}

function ExportReportsPage({ masterData }) {
  const [availableMonths, setAvailableMonths] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [loadError, setLoadError] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [fromMonth, setFromMonth] = React.useState('');
  const [toMonth, setToMonth] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    DataStore.getAvailableMonths().then((storedMonths) => {
      if (!alive) return;
      const current = Utils.monthKey(Utils.todayISO());
      const months = Array.from(new Set([current, ...(storedMonths || [])])).filter(Boolean).sort();
      setAvailableMonths(months);
      setFromMonth(current);
      setToMonth(current);
    }).catch((err) => {
      console.error(err);
      if (alive) {
        const message = DataStore.describeError(err, 'Could not load report data.');
        setLoadError(message);
        Toast.error(message);
      }
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  async function loadReportRows(months) {
    if (!months.length) return { transactions: [], budgets: [] };
    const first = months[0];
    const last = months[months.length - 1];
    const [transactions, reportBudgets] = await Promise.all([
      DataStore.getTransactions({ fromDate: `${first}-01`, toDate: `${last}-31`, all: true }),
      DataStore.getBudgets({ fromMonth: first, toMonth: last, all: true }),
    ]);
    return { transactions, budgets: reportBudgets };
  }

  function monthsInRange() {
    if (!fromMonth || !toMonth) return [];
    const out = [];
    let cur = fromMonth <= toMonth ? fromMonth : toMonth;
    const end = fromMonth <= toMonth ? toMonth : fromMonth;
    while (cur <= end) {
      out.push(cur);
      if (out.length > 600) throw new Error('The selected report range is too large.');
      cur = Utils.addMonths(cur, 1);
    }
    return out;
  }

  async function generate() {
    setBusy(true);
    try {
      const months = monthsInRange();
      const rows = await loadReportRows(months);
      const wb = new ExcelJS.Workbook();
      wb.creator = APP_NAME;
      await buildInflowSheet(wb, masterData, rows.transactions, months);
      await buildOutflowSheet(wb, masterData, rows.transactions, rows.budgets, months);
      await buildInternalTransferSheet(wb, masterData, rows.transactions, months);
      await buildWorkingCapitalSheet(wb, masterData, rows.transactions, months);
      await buildRawDataSheet(wb, masterData, rows.transactions, months);
      const buf = await wb.xlsx.writeBuffer();
      Utils.downloadBlob(new Blob([buf], { type: 'application/octet-stream' }), `VIBRANT CashFlow Report - ${months[0] || ''} to ${months[months.length - 1] || ''}.xlsx`);
      Toast.success('Report downloaded.');
    } catch (err) {
      console.error(err);
      Toast.error(err.message || 'Could not generate the report.');
    } finally {
      setBusy(false);
    }
  }

  async function generateHtml() {
    setBusy(true);
    try {
      const months = monthsInRange();
      const rows = await loadReportRows(months);
      const response = await fetch(BRAND_LOGO_PATH);
      if (!response.ok) throw new Error('Brand logo could not be loaded.');
      const blob = await response.blob();
      const logoDataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Brand logo could not be embedded.'));
        reader.readAsDataURL(blob);
      });
      const html = buildHtmlReport(masterData, rows.transactions, rows.budgets, months, logoDataUrl);
      Utils.downloadBlob(new Blob([html], { type: 'text/html' }), `VIBRANT CashFlow Analysis - ${months[0] || ''} to ${months[months.length - 1] || ''}.html`);
      Toast.success('Analysis report downloaded.');
    } catch (err) {
      console.error(err);
      Toast.error('Could not generate the analysis report.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <PageLoader />;
  if (loadError) return <EmptyState icon="⚠️" title={loadError} sub="Reload the page to try again." />;
  const monthOptions = availableMonths.slice().sort().reverse().map((value) => ({ value, label: Utils.monthLabel(value) }));

  return (
    <div>
      <SectionCard title="Generate report">
        <div className="toolbar" style={{ marginBottom: 18, alignItems: 'flex-end' }}>
          <div className="field" style={{ width: 220, flex: '0 0 220px', marginBottom: 0 }}>
            <label>From Month</label>
            <SearchableSelect ariaLabel="From Month" options={monthOptions} value={fromMonth} onChange={(v) => v && setFromMonth(v)} clearable={false} placeholder="From" />
          </div>
          <div className="field" style={{ width: 220, flex: '0 0 220px', marginBottom: 0 }}>
            <label>To Month</label>
            <SearchableSelect ariaLabel="To Month" options={monthOptions} value={toMonth} onChange={(v) => v && setToMonth(v)} clearable={false} placeholder="To" />
          </div>
        </div>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button type="button" className="btn btn-accent" onClick={generate} disabled={busy || !fromMonth}>
            {busy ? <span className="spinner on-dark"></span> : '📤 Excel Workbook (.xlsx)'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={generateHtml} disabled={busy || !fromMonth}>
            🌐 Analysis Report (.html)
          </button>
        </div>
      </SectionCard>
    </div>
  );
}
