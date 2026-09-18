function emptyDraft() { return { type: '', verticalId: '', headId: '', subHeadId: '' }; }
function Categorize_RowSelects({ draft, onChange, masterData, disabled }) {
  return <React.Fragment>
    <td style={{ minWidth: 110 }}><Tabs items={[{ value: 'outflow', label: 'Out' }, { value: 'inflow', label: 'In' }, { value: 'internal', label: 'Int' }]}
      value={draft.type} onChange={(type) => onChange({ ...draft, type, headId: '', subHeadId: '' })} disabled={disabled} /></td>
    <td style={{ minWidth: 160 }}><SearchableSelect size="sm" options={MasterHelpers.verticalOptions(masterData)} value={draft.verticalId}
      onChange={(verticalId) => onChange({ ...draft, verticalId, headId: '', subHeadId: '' })} placeholder="Vertical" disabled={disabled} /></td>
    <td style={{ minWidth: 170 }}><SearchableSelect size="sm" options={MasterHelpers.headOptions(masterData, draft.verticalId, draft.type)} value={draft.headId}
      onChange={(headId) => onChange({ ...draft, headId, subHeadId: '' })} placeholder="Head" disabled={disabled || !draft.verticalId} /></td>
    <td style={{ minWidth: 180 }}><SearchableSelect size="sm" options={MasterHelpers.subHeadOptions(masterData, draft.headId)} value={draft.subHeadId}
      onChange={(subHeadId) => onChange({ ...draft, subHeadId })} placeholder="Sub-head" disabled={disabled || !draft.headId} /></td>
  </React.Fragment>;
}

function CategorizePage({ user, masterData, settings }) {
  const [selectionMode, setSelectionMode] = React.useState('search');
  const [tab, setTab] = React.useState('pending');
  const [searchText, setSearchText] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [fromDate, setFromDate] = React.useState('');
  const [toDate, setToDate] = React.useState('');
  const [cursors, setCursors] = React.useState([null]);
  const [page, setPage] = React.useState(0);
  const [result, setResult] = React.useState({ rows: [], cursor: null, hasMore: false });
  const [mapping, setMapping] = React.useState({});
  const [edits, setEdits] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState('');
  const [bulk, setBulk] = React.useState(emptyDraft());
  const [editing, setEditing] = React.useState(null);
  const [reload, setReload] = React.useState(0);
  const generation = React.useRef(0);
  // Pages already fetched in this visit (Prev/tab switches cost no reads).
  // Cleared whenever rows are saved; a reload uses new cache keys.
  const pageCache = React.useRef(new Map());
  const editCount = Object.keys(edits).length;
  useUnsavedChanges(editCount > 0 || saving);

  React.useEffect(() => {
    const token = ++generation.current;
    setLoading(true); setError('');
    if (fromDate && toDate && fromDate > toDate) { setError('From date must be on or before To date.'); setLoading(false); return; }
    const cacheKey = JSON.stringify([reload, tab, search, fromDate, toDate, cursors[page] || null]);
    const cachedPage = pageCache.current.get(cacheKey);
    if (cachedPage) { setResult(cachedPage); setLoading(false); return; }
    Promise.all([
      DataStore.getTransactionPage({ status: tab === 'pending' ? TXN_STATUS.UNCATEGORIZED : '', search, fromDate, toDate, after: cursors[page] }),
      DataStore.getMappingMemory(),
    ]).then(([rows, memory]) => { if (token === generation.current) { pageCache.current.set(cacheKey, rows); setResult(rows); setMapping(memory); } })
      .catch((err) => { if (token === generation.current) setError(DataStore.describeError(err)); })
      .finally(() => { if (token === generation.current) setLoading(false); });
    return () => { generation.current++; };
  }, [tab, search, fromDate, toDate, page, cursors, reload]);

  function resetPages() { setPage(0); setCursors([null]); }
  function draftFor(t) {
    if (edits[t.id]) return edits[t.id].draft;
    if (t.status === TXN_STATUS.CATEGORIZED) return { type: t.type, verticalId: t.verticalId, headId: t.headId, subHeadId: t.subHeadId };
    const suggestion = mapping[Utils.mappingMemoryKey(t.remarksBank || t.particulars)];
    if (suggestion && MasterHelpers.validateSelection(masterData, suggestion, suggestion.type).valid) return suggestion;
    return { ...emptyDraft(), type: t.type || (Utils.netCash(t) > 0 ? 'inflow' : 'outflow') };
  }
  function edit(t, draft) {
    setEdits((old) => ({ ...old, [t.id]: { record: old[t.id]?.record || t, draft, operationId: Utils.genId('category') } }));
  }
  function applyBulk() {
    const validation = MasterHelpers.validateSelection(masterData, bulk, bulk.type);
    if (!validation.valid) { Toast.error(validation.error); return; }
    setEdits((old) => {
      const next = { ...old };
      result.rows.filter((t) => t.status !== 'void' && Auth.canEditTransactionDate(user, t.date, settings))
        .forEach((t) => { next[t.id] = { record: old[t.id]?.record || t, draft: { ...bulk }, operationId: Utils.genId('category') }; });
      return next;
    });
  }
  function acceptSaved(rows) {
    pageCache.current.clear();
    const byId = new Map(rows.map((r) => [r.id, r]));
    setEdits((old) => Object.fromEntries(Object.entries(old).filter(([id]) => !byId.has(id))));
    setResult((old) => ({ ...old, rows: old.rows.map((r) => byId.get(r.id) || r).filter((r) => tab !== 'pending' || r.status === TXN_STATUS.UNCATEGORIZED) }));
  }
  async function saveAll() {
    if (saving || loading) return;
    setSaving(true);
    const candidates = { ...edits };
    // Suggestions for the visible page can be reviewed and saved as before.
    result.rows.forEach((t) => { if (!candidates[t.id]) candidates[t.id] = { record: t, draft: draftFor(t), operationId: Utils.genId('category') }; });
    let toSave = [];
    try {
      const [md, st] = await Promise.all([DataStore.getMasterData(), DataStore.getSettings()]);
      for (const { record: t, draft, operationId } of Object.values(candidates)) {
        if (t.status === 'void' || !Auth.canEditTransactionDate(user, t.date, st)) continue;
        if (t.status === TXN_STATUS.CATEGORIZED && ['type', 'verticalId', 'headId', 'subHeadId'].every((key) => t[key] === draft[key])) continue;
        const validation = MasterHelpers.validateSelection(md, draft, draft.type);
        if (!validation.valid) { if (edits[t.id]) throw new Error(validation.error + ' Complete or discard this draft before saving.'); continue; }
        toSave.push({ ...t, type: draft.type, verticalId: draft.verticalId, headId: draft.headId, subHeadId: draft.subHeadId,
          categorySnapshot: validation.snapshot, status: TXN_STATUS.CATEGORIZED, updatedAt: new Date().toISOString(),
          _expectedRevision: Number(t._revision) || 0, _operationId: operationId });
      }
      if (!toSave.length) { Toast.info('No valid category changes to save. Locked or incomplete drafts remain unsaved.'); return; }
      // Retain operation IDs for suggestions too, so retries are idempotent.
      setEdits((old) => ({ ...old, ...Object.fromEntries(toSave.map((t) => [t.id, candidates[t.id]])) }));
      const saved = await DataStore.bulkUpsertTransactions(toSave);
      acceptSaved(saved);
      Toast.success(`Saved ${saved.length} transaction(s).`);
      try { await DataStore.rememberMappings(saved.map((t) => ({ remark: t.remarksBank || t.particulars,
        mapping: { type: t.type, verticalId: t.verticalId, headId: t.headId, subHeadId: t.subHeadId } }))); }
      catch (_) { Toast.info('Transactions are saved. Suggestions could not be updated.'); }
    } catch (err) { if (err.savedRows) acceptSaved(err.savedRows); setError(err.message); Toast.error(err.message); }
    finally { setSaving(false); }
  }
  function discard() {
    if (!editCount || window.confirm('Discard all unsaved category changes and reload current records?')) {
      setEdits({}); setReload((n) => n + 1);
    }
  }
  return <div>
    <div className="page-bar">
      <div className="page-bar-row">
        <Tabs disabled={saving} items={[{ value: 'pending', label: 'Pending' }, { value: 'all', label: 'All Transactions' }]} value={tab} onChange={(value) => { setTab(value); resetPages(); }} />
        <label>From <input aria-label="Transactions from date" className="input" type="date" value={fromDate} disabled={saving} onChange={(e) => { setFromDate(e.target.value); resetPages(); }} /></label>
        <label>To <input aria-label="Transactions to date" className="input" type="date" value={toDate} disabled={saving} onChange={(e) => { setToDate(e.target.value); resetPages(); }} /></label>
        <form className="page-bar-search" onSubmit={(e) => { e.preventDefault(); setSearch(searchText); resetPages(); }}>
          <input aria-label="Search all transactions" className="input" placeholder="Particulars, remarks, bank or ID" value={searchText} disabled={saving} onChange={(e) => setSearchText(e.target.value)} />
          <button className="btn btn-secondary" disabled={saving}>Search</button>
        </form>
        <div className="spacer" />
        <button className="btn btn-primary" onClick={saveAll} disabled={saving || loading}>{saving ? 'Saving…' : `Save changes${editCount ? ` (${editCount} drafts)` : ''}`}</button>
        <button className="btn btn-ghost" disabled={saving} onClick={discard}>{editCount ? 'Discard drafts & reload' : 'Refresh'}</button>
      </div>
      <div className="page-bar-row">
        <span className="cell-muted">Apply to page</span>
        <CategoryPicker masterData={masterData} value={bulk} onChange={setBulk} disabled={saving} />
        <button className="btn btn-secondary" disabled={saving || loading} onClick={applyBulk}>Apply to this page</button>
        <div className="spacer" />
        <span className="cell-muted">Category input</span>
        <Tabs disabled={saving} items={[{ value: 'search', label: 'Single search' }, { value: 'steps', label: 'Step by step' }]} value={selectionMode} onChange={setSelectionMode} />
      </div>
    </div>
    {error && <p role="alert" className="error-text">{error}</p>}
    {loading ? <PageLoader /> : <React.Fragment>
      {result.rows.length === 0 ? <EmptyState title={result.hasMore ? 'No matches in this part of the search' : 'No matching transactions'} sub={result.hasMore ? 'Continue searching the remaining records below.' : ''} /> :
        <div className="table-wrap"><table className="dtable"><thead><tr><th>Date / Bank</th><th>Particulars</th><th>Amount</th>{selectionMode === 'search' ? <th>Category · search Master Data</th> : <React.Fragment><th>Type</th><th>Vertical</th><th>Head</th><th>Sub-head</th></React.Fragment>}<th>Status / Actions</th></tr></thead><tbody>
          {result.rows.map((t) => <tr key={t.id}>
            <td>{Utils.formatDate(t.date)}<div className="cell-muted">{t.bankName || 'Cash'}</div></td>
            <td>{t.particulars}<div className="cell-muted">{t.remarksBank}</div>{t.categorySnapshot && <div className="help-text">Saved: {t.categorySnapshot.verticalName} / {t.categorySnapshot.headName} / {t.categorySnapshot.subHeadName}</div>}</td>
            <td className="cell-num">{Utils.formatCurrency(Utils.netCash(t))}</td>
            {selectionMode === 'search' ? <td className="category-cell"><CategorySearch masterData={masterData} value={draftFor(t)} onChange={(draft) => edit(t, draft)} disabled={saving || t.status === 'void' || !Auth.canEditTransactionDate(user, t.date, settings)} size="sm" /></td> : <Categorize_RowSelects draft={draftFor(t)} onChange={(draft) => edit(t, draft)} masterData={masterData} disabled={saving || t.status === 'void' || !Auth.canEditTransactionDate(user, t.date, settings)} />}
            <td><Badge tone={t.status === 'categorized' ? 'success' : 'neutral'}>{t.status === 'void' ? 'Cancelled' : !Auth.canEditTransactionDate(user, t.date, settings) ? 'Locked' : t.status}</Badge>
              <button className="btn btn-ghost btn-sm" disabled={saving || !!edits[t.id]} onClick={() => setEditing(t)}>Details / Correct</button></td>
          </tr>)}
        </tbody></table></div>}
      <div className="toolbar" style={{ justifyContent: 'flex-end', marginTop: 12 }}>
        <button className="btn btn-secondary" disabled={page === 0 || saving} onClick={() => setPage((n) => n - 1)}>← Prev</button>
        <span>Page {page + 1}</span><button className="btn btn-secondary" disabled={!result.hasMore || saving} onClick={() => { setCursors((old) => [...old.slice(0, page + 1), result.cursor]); setPage((n) => n + 1); }}>{search ? 'Continue search →' : 'Next →'}</button>
      </div>
    </React.Fragment>}
    {editing && <TransactionEditor record={editing} user={user} masterData={masterData} settings={settings} onClose={() => setEditing(null)} onSaved={(row) => { acceptSaved([row]); setEditing(null); setReload((n) => n + 1); }} />}
  </div>;
}
