// ============================================================================
// VIBRANT CashFlow — Budget & Booking (Outflow only)
// ============================================================================

function parseBudgetValue(value) {
  const parsed = Utils.parseAmountStrict(value, 0);
  return parsed != null && parsed >= 0 ? parsed : null;
}

function parseBudgetImportWorkbook(workbook) {
  const ws = workbook.Sheets[workbook.SheetNames[0]];
  if (!ws) throw new Error('The workbook has no readable sheet.');
  const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  if (rawRows.length < 2) throw new Error('The Budget workbook is empty.');
  const columnNames = { vertical: 'vertical', head: 'head', subhead: 'subHead', budget: 'budget', booking: 'booking' };
  const headerMap = {};
  const duplicateHeaders = [];
  rawRows[0].forEach((value, index) => {
    const key = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    const field = columnNames[key];
    if (!field) return;
    if (headerMap[field] != null) duplicateHeaders.push(String(value));
    else headerMap[field] = index;
  });
  const missingHeaders = Object.values(columnNames).filter((field) => headerMap[field] == null);
  if (missingHeaders.length || duplicateHeaders.length) {
    throw new Error(`Header problem: ${missingHeaders.length ? `missing ${missingHeaders.join(', ')}` : ''}${missingHeaders.length && duplicateHeaders.length ? '; ' : ''}${duplicateHeaders.length ? `duplicate ${duplicateHeaders.join(', ')}` : ''}. Download and use the template.`);
  }
  const rows = rawRows.slice(1).filter((row) => row && row.some((value) => value != null && String(value).trim() !== ''));
  if (rows.length === 0) throw new Error('The Budget workbook has no data rows.');
  return { rows, headerMap };
}

function BudgetBookingPage({ user, masterData }) {
  const [month, setMonth] = React.useState(Utils.monthKey(Utils.todayISO()));
  const [budgets, setBudgets] = React.useState([]);
  const [draft, setDraft] = React.useState({}); // subHeadId -> {budget, booking}
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [importBusy, setImportBusy] = React.useState(false);
  const [confirmCopy, setConfirmCopy] = React.useState(false);
  const [dirty, setDirty] = React.useState({});
  const [replaceMonth, setReplaceMonth] = React.useState(false);
  const [confirmMonth, setConfirmMonth] = React.useState('');
  const [loadError, setLoadError] = React.useState('');
  const fileRef = React.useRef(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const all = await DataStore.getBudgets({ fromMonth: Utils.addMonths(month, -1), toMonth: month, all: true });
      setBudgets(all);
      const map = {};
      all.filter((b) => b.month === month).forEach((b) => { map[b.subHeadId] = { budget: b.budget, booking: b.booking }; });
      setDraft(map);
      setDirty({});
      setReplaceMonth(false);
    } catch (err) {
      console.error(err); setDraft({}); setDirty({});
      const message = DataStore.describeError(err, 'Could not load Budget & Booking data.');
      setLoadError(message);
      Toast.error(message);
    } finally { setLoading(false); }
  }, [month]);

  React.useEffect(() => { load(); }, [load]);

  // Internal Transfer (group "internal") isn't real spend — nothing to budget for.
  const tree = MasterHelpers.headTree(masterData, 'outflow')
    .map((g) => ({ ...g, heads: g.heads.filter((h) => h.head.group !== 'internal') }))
    .filter((g) => g.heads.length > 0);
  const selectionBySub = {};
  const budgetPaths = [];
  tree.forEach((g) => g.heads.forEach((h) => h.subHeads.forEach((s) => {
    selectionBySub[s.id] = { verticalId: g.vertical.id, headId: h.head.id, subHeadId: s.id };
    budgetPaths.push({
      verticalName: String(g.vertical.name || '').trim().toLowerCase(),
      headName: String(h.head.name || '').trim().toLowerCase(),
      subName: String(s.name || '').trim().toLowerCase(),
      subHeadId: s.id,
    });
  })));
  const savedBudgetBySub = new Map(budgets.filter((item) => item.month === month).map((item) => [item.subHeadId, item]));
  const archivedBudgets = budgets.filter((item) => item.month === month && !selectionBySub[item.subHeadId]);

  function savedCategoryLabel(subHeadId) {
    const saved = savedBudgetBySub.get(subHeadId);
    const currentSelection = selectionBySub[subHeadId];
    if (!saved || !saved.categorySnapshot || !currentSelection) return '';
    const current = MasterHelpers.snapshotForSelection(masterData, currentSelection);
    const historical = MasterHelpers.resolveTransactionChain(masterData, saved);
    if (MasterHelpers.snapshotKey(current) === MasterHelpers.snapshotKey(historical)) return '';
    return `${historical.verticalName} / ${historical.headName} / ${historical.subHeadName}`;
  }

  function requestMonthChange(nextMonth) {
    if (!nextMonth || nextMonth === month) return;
    if (Object.keys(dirty).length > 0 || replaceMonth) setConfirmMonth(nextMonth);
    else setMonth(nextMonth);
  }

  function setCell(subHeadId, field, val) {
    setDraft((d) => ({ ...d, [subHeadId]: { ...(d[subHeadId] || { budget: '', booking: '' }), [field]: val } }));
    setDirty((d) => ({ ...d, [subHeadId]: true }));
  }

  function copyPreviousMonth() {
    const prev = Utils.addMonths(month, -1);
    const map = {};
    budgets.filter((b) => b.month === prev && selectionBySub[b.subHeadId]).forEach((b) => { map[b.subHeadId] = { budget: b.budget, booking: b.booking }; });
    if (Object.keys(map).length === 0) { Toast.error(`No budget found for ${Utils.monthLabel(prev)}.`); setConfirmCopy(false); return; }
    setDraft(map);
    setDirty(Object.keys(map).reduce((out, id) => { out[id] = true; return out; }, {}));
    setReplaceMonth(true);
    setConfirmCopy(false);
    Toast.success(`Copied from ${Utils.monthLabel(prev)}. Review and Save.`);
  }

  async function save() {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { Toast.error('Select a valid month.'); return; }
    if (!replaceMonth && Object.keys(dirty).length === 0) { Toast.info('Nothing has changed.'); return; }
    setSaving(true);
    try {
      const latest = await DataStore.getBudgets({ month, all: true });
      const targetIds = replaceMonth ? Object.keys(draft) : Object.keys(dirty);
      const expectedRevisions = {};
      if (replaceMonth) {
        budgets.filter((item) => item.month === month).forEach((item) => {
          expectedRevisions[item.subHeadId] = Number(item._revision) || 0;
        });
      } else {
        targetIds.forEach((subHeadId) => {
          const loaded = budgets.find((item) => item.month === month && item.subHeadId === subHeadId);
          expectedRevisions[subHeadId] = loaded ? (Number(loaded._revision) || 0) : null;
        });
      }
      const parsed = [];
      for (const subHeadId of targetIds) {
        const values = draft[subHeadId] || {};
        const budget = parseBudgetValue(values.budget);
        const booking = parseBudgetValue(values.booking);
        if (budget == null || booking == null) throw new Error('Budget and Booking must be non-negative numbers.');
        const selection = selectionBySub[subHeadId];
        if (!selection) throw new Error('A selected budget category no longer exists in Master Data.');
        const categorySnapshot = MasterHelpers.snapshotForSelection(masterData, selection);
        if (!categorySnapshot) throw new Error('Budget category hierarchy is invalid.');
        const existing = latest.find((b) => b.month === month && b.subHeadId === subHeadId);
        if (budget !== 0 || booking !== 0) parsed.push({
          id: existing ? existing.id : Utils.genId('bud'), month, subHeadId, budget, booking,
          categorySnapshot, updatedBy: user.id, updatedAt: new Date().toISOString(),
        });
      }

      if (replaceMonth) await DataStore.replaceBudgetsForMonth(month, parsed, expectedRevisions);
      else await DataStore.patchBudgetsForMonth(month, targetIds, parsed, expectedRevisions);
      Toast.success('Budget & Booking saved.');
      await load();
    } catch (err) {
      console.error(err); Toast.error(err.message || 'Could not save Budget & Booking.');
    } finally { setSaving(false); }
  }

  function downloadTemplate() {
    const rows = [['Vertical', 'Head', 'Sub-head', 'Budget', 'Booking']];
    tree.forEach((g) => g.heads.forEach((h) => h.subHeads.forEach((s) => {
      const d = draft[s.id];
      rows.push([g.vertical.name, h.head.name, s.name, d && d.budget ? d.budget : '', d && d.booking ? d.booking : '']);
    })));
    const ws = XLSX.utils.aoa_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Budget');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    Utils.downloadBlob(new Blob([out], { type: 'application/octet-stream' }), `Budget Template - ${Utils.monthLabel(month)}.xlsx`);
  }

  async function onImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setImportBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const parsedWorkbook = parseBudgetImportWorkbook(wb);
      const { rows, headerMap } = parsedWorkbook;
      const pathCounts = new Map();
      rows.forEach((row) => {
        const key = JSON.stringify([row[headerMap.vertical], row[headerMap.head], row[headerMap.subHead]]
          .map((value) => String(value || '').trim().toLowerCase()));
        pathCounts.set(key, (pathCounts.get(key) || 0) + 1);
      });
      let matched = 0, unmatched = 0, invalid = 0;
      const next = { ...draft };
      const changed = { ...dirty };
      rows.forEach((row) => {
        const verticalName = String(row[headerMap.vertical] || '').trim().toLowerCase();
        const headName = String(row[headerMap.head] || '').trim().toLowerCase();
        const subName = String(row[headerMap.subHead] || '').trim().toLowerCase();
        if (pathCounts.get(JSON.stringify([verticalName, headName, subName])) > 1) { invalid++; return; }
        const match = budgetPaths.find((p) => p.verticalName === verticalName && p.headName === headName && p.subName === subName);
        if (!match) { unmatched++; return; }
        const budget = parseBudgetValue(row[headerMap.budget]);
        const booking = parseBudgetValue(row[headerMap.booking]);
        if (budget == null || booking == null) { invalid++; return; }
        matched++;
        next[match.subHeadId] = { budget, booking };
        changed[match.subHeadId] = true;
      });
      setDraft(next);
      setDirty(changed);
      Toast.success(`Imported ${matched} row(s)${unmatched ? `, ${unmatched} unmatched` : ''}${invalid ? `, ${invalid} invalid` : ''}. Review and Save.`);
    } catch (err) {
      console.error(err); Toast.error(err.message || 'Could not read that Budget workbook.');
    } finally {
      setImportBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  if (loading) return <PageLoader />;
  if (loadError) return <EmptyState icon="⚠️" title={loadError} sub="Reload the page to try again." />;

  return (
    <div>
      <div className="toolbar">
        <label className="visually-hidden" htmlFor="budget-month">Budget month</label>
        <input id="budget-month" className="input" type="month" style={{ maxWidth: 180 }} value={month} onChange={(e) => requestMonthChange(e.target.value)} />
        <button type="button" className="btn btn-secondary" onClick={() => setConfirmCopy(true)} disabled={saving || importBusy}>📋 Copy Previous Month</button>
        <div className="spacer" />
        <button type="button" className="btn btn-secondary" onClick={downloadTemplate} disabled={saving || importBusy}>⬇️ Download Template</button>
        <label className={Utils.classNames('btn btn-secondary', importBusy && 'disabled')} style={{ cursor: importBusy ? 'not-allowed' : 'pointer' }} tabIndex={importBusy ? -1 : 0}
          onKeyDown={(e) => { if (!importBusy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current && fileRef.current.click(); } }}>
          {importBusy ? <React.Fragment><span className="spinner"></span> Importing…</React.Fragment> : '⬆️ Import'}
          <input ref={fileRef} className="visually-hidden" tabIndex="-1" type="file" accept=".xlsx,.xls" onChange={onImportFile} disabled={importBusy} />
        </label>
        <button type="button" className="btn btn-primary" onClick={save} disabled={saving || importBusy}>{saving ? <span className="spinner on-dark"></span> : 'Save'}</button>
      </div>

      {tree.length === 0 && archivedBudgets.length === 0 ? (
        <EmptyState icon="📁" title="No outflow Master Data yet" sub="Add an outflow Vertical, Head and Sub-head in Master Data before creating a budget." />
      ) : tree.map((g) => (
        <SectionCard key={g.vertical.id} title={g.vertical.name}>
          <div className="table-wrap">
            <table className="dtable">
              <thead><tr><th>Head</th><th>Sub-head</th><th className="cell-num">Budget (₹)</th><th className="cell-num">Booking (₹)</th></tr></thead>
              <tbody>
                {g.heads.map((h) => h.subHeads.map((s, i) => (
                  <tr key={s.id}>
                    {i === 0 && (
                      <td rowSpan={h.subHeads.length} className="cell-muted" style={{ verticalAlign: 'top' }}>
                        {h.head.name}{h.head.group && <React.Fragment> <Badge tone={MasterHelpers.groupTone(h.head.group)}>{h.head.group}</Badge></React.Fragment>}
                      </td>
                    )}
                    <td>
                      {s.name}
                      {savedCategoryLabel(s.id) && <div className="cell-muted" style={{ fontSize: 11 }}>Saved as: {savedCategoryLabel(s.id)}</div>}
                    </td>
                    <td className="cell-num"><input aria-label={`${s.name} budget`} className="input" type="number" min="0" step="0.01" style={{ textAlign: 'right' }} value={draft[s.id] && draft[s.id].budget != null ? draft[s.id].budget : ''} onChange={(e) => setCell(s.id, 'budget', e.target.value)} placeholder="0" /></td>
                    <td className="cell-num"><input aria-label={`${s.name} booking`} className="input" type="number" min="0" step="0.01" style={{ textAlign: 'right' }} value={draft[s.id] && draft[s.id].booking != null ? draft[s.id].booking : ''} onChange={(e) => setCell(s.id, 'booking', e.target.value)} placeholder="0" /></td>
                  </tr>
                )))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      ))}

      {archivedBudgets.length > 0 && (
        <SectionCard title="Archived saved budget categories" sub="These rows remain in historical reports although their Master Data category was deleted.">
          <div className="table-wrap">
            <table className="dtable">
              <thead><tr><th>Saved category</th><th className="cell-num">Budget (₹)</th><th className="cell-num">Booking (₹)</th></tr></thead>
              <tbody>{archivedBudgets.map((item) => {
                const chain = MasterHelpers.resolveTransactionChain(masterData, item);
                return <tr key={item.id}><td>{chain.verticalName} / {chain.headName} / {chain.subHeadName}</td><td className="cell-num">{Utils.formatCurrency(item.budget)}</td><td className="cell-num">{Utils.formatCurrency(item.booking)}</td></tr>;
              })}</tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {confirmCopy && (
        <ConfirmModal title="Copy previous month" message={`This will replace the current draft with ${Utils.monthLabel(Utils.addMonths(month, -1))}'s Budget & Booking figures. Nothing is saved until you click Save.`} confirmLabel="Copy" onCancel={() => setConfirmCopy(false)} onConfirm={copyPreviousMonth} />
      )}
      {confirmMonth && (
        <ConfirmModal title="Discard unsaved changes?" tone="danger" confirmLabel="Discard and change month"
          message={`You have unsaved Budget & Booking changes for ${Utils.monthLabel(month)}.`}
          onCancel={() => setConfirmMonth('')} onConfirm={() => { const next = confirmMonth; setConfirmMonth(''); setMonth(next); }} />
      )}
    </div>
  );
}
