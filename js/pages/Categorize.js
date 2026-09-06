// ============================================================================
// VIBRANT CashFlow — Categorize Transactions
// ============================================================================

const PAGE_SIZE = 50;

function emptyDraft() { return { type: '', verticalId: '', headId: '', subHeadId: '' }; }

function Categorize_RowSelects({ draft, onChange, masterData, disabled }) {
  const headOpts = MasterHelpers.headOptions(masterData, draft.verticalId, draft.type || null);
  const subOpts = MasterHelpers.subHeadOptions(masterData, draft.headId);
  return (
    <React.Fragment>
      <td style={{ minWidth: 110 }}>
        <Tabs items={[{ value: TXN_TYPE.OUTFLOW, label: 'Out' }, { value: TXN_TYPE.INFLOW, label: 'In' }, { value: TXN_TYPE.INTERNAL, label: 'Int' }]}
          value={draft.type} onChange={(v) => onChange({ ...draft, type: v, headId: '', subHeadId: '' })} disabled={disabled} />
      </td>
      <td style={{ minWidth: 160 }}>
        <SearchableSelect size="sm" options={MasterHelpers.verticalOptions(masterData)} value={draft.verticalId}
          onChange={(v) => onChange({ ...draft, verticalId: v, headId: '', subHeadId: '' })} placeholder="Vertical" disabled={disabled} />
      </td>
      <td style={{ minWidth: 170 }}>
        <SearchableSelect size="sm" options={headOpts} value={draft.headId}
          onChange={(v) => onChange({ ...draft, headId: v, subHeadId: '' })} placeholder="Head" disabled={disabled || !draft.verticalId} />
      </td>
      <td style={{ minWidth: 180 }}>
        <SearchableSelect size="sm" options={subOpts} value={draft.subHeadId}
          onChange={(v) => onChange({ ...draft, subHeadId: v })} placeholder="Sub-head" disabled={disabled || !draft.headId} />
      </td>
    </React.Fragment>
  );
}

function CategorizePage({ user, masterData, settings }) {
  const [tab, setTab] = React.useState('pending');
  const [search, setSearch] = React.useState('');
  const [page, setPage] = React.useState(0);
  const [txns, setTxns] = React.useState([]);
  const [mapping, setMapping] = React.useState({});
  const [drafts, setDrafts] = React.useState({});
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [bulk, setBulk] = React.useState(emptyDraft());

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [all, rawMemory] = await Promise.all([
        DataStore.getTransactions({ status: tab === 'pending' ? TXN_STATUS.UNCATEGORIZED : '', limit: FIREBASE_QUERY_PAGE_SIZE }),
        DataStore.getMappingMemory(),
      ]);
      const mem = {};
      Object.keys(rawMemory || {}).forEach((key) => {
        const suggestion = rawMemory[key];
        if (MasterHelpers.validateSelection(masterData, suggestion, suggestion && suggestion.type).valid) mem[key] = suggestion;
      });
      setMapping(mem);
      setTxns(all);

      setDrafts(() => {
        const next = {};
        all.forEach((t) => {
          if (next[t.id]) return;
          if (t.status === TXN_STATUS.CATEGORIZED) {
            next[t.id] = { type: t.type, verticalId: t.verticalId, headId: t.headId, subHeadId: t.subHeadId };
          } else {
            const key = (t.remarksBank || t.particulars || '').trim().toLowerCase();
            const suggestion = mem[key];
            next[t.id] = suggestion ? { ...suggestion } : emptyDraft();
            const net = Utils.netCash(t);
            if (!next[t.id].type && net !== 0) next[t.id].type = net > 0 ? TXN_TYPE.INFLOW : TXN_TYPE.OUTFLOW;
          }
        });
        return next;
      });
    } catch (err) {
      console.error(err);
      Toast.error('Could not load transactions for categorization.');
    } finally {
      setLoading(false);
    }
  }, [masterData, tab]);

  React.useEffect(() => { load(); }, [load]);
  React.useEffect(() => { setPage(0); }, [tab, search]);

  const base = tab === 'pending' ? txns.filter((t) => t.status === TXN_STATUS.UNCATEGORIZED) : txns.slice();
  const q = search.trim().toLowerCase();
  const filtered = (q ? base.filter((t) => (t.particulars + ' ' + t.remarksBank + ' ' + t.particulars2).toLowerCase().includes(q)) : base)
    .sort((a, b) => b.date.localeCompare(a.date));
  const pageRows = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  React.useEffect(() => { if (page >= totalPages) setPage(totalPages - 1); }, [page, totalPages]);

  function setDraft(id, val) { setDrafts((d) => ({ ...d, [id]: val })); }

  function applyBulk() {
    const validation = MasterHelpers.validateSelection(masterData, bulk, bulk.type);
    if (!validation.valid) {
      Toast.error(validation.error);
      return;
    }
    setDrafts((d) => {
      const next = { ...d };
      filtered.forEach((t) => { next[t.id] = { ...bulk }; });
      return next;
    });
    Toast.success(`Applied to ${filtered.length} row(s). Review, then Save.`);
  }

  async function saveAll() {
    const toSave = [];
    let incomplete = 0, locked = 0, unchanged = 0, invalid = 0;
    filtered.forEach((t) => {
      // Never persist a change to a row this user isn't allowed to touch —
      // the disabled dropdowns are a UI convenience, not the real guard.
      if (!Auth.canEditTransactionDate(user, t.date, settings)) { locked++; return; }
      const d = drafts[t.id];
      if (!d || !d.type || !d.verticalId || !d.headId || !d.subHeadId) { incomplete++; return; }
      const validation = MasterHelpers.validateSelection(masterData, d, d.type);
      if (!validation.valid) { invalid++; return; }
      const isSame = t.status === TXN_STATUS.CATEGORIZED
        && t.type === d.type && t.verticalId === d.verticalId && t.headId === d.headId && t.subHeadId === d.subHeadId;
      if (isSame) { unchanged++; return; }
      toSave.push({
        ...t, type: d.type, verticalId: d.verticalId, headId: d.headId, subHeadId: d.subHeadId,
        categorySnapshot: validation.snapshot,
        _expectedRevision: Number(t._revision) || 0,
        status: TXN_STATUS.CATEGORIZED, updatedAt: new Date().toISOString(), updatedBy: user.id,
      });
    });
    if (toSave.length === 0) {
      Toast.info(unchanged ? 'No category changes to save.' : 'No valid, fully-mapped rows to save.');
      return;
    }
    setSaving(true);
    try {
      await DataStore.bulkUpsertTransactions(toSave);
      await DataStore.rememberMappings(toSave.map((t) => ({
        remark: t.remarksBank || t.particulars,
        mapping: { type: t.type, verticalId: t.verticalId, headId: t.headId, subHeadId: t.subHeadId },
      })));
      Toast.success(`Saved ${toSave.length} row(s)${incomplete ? `, ${incomplete} incomplete` : ''}${invalid ? `, ${invalid} invalid` : ''}${locked ? `, ${locked} locked` : ''}.`);
      await load();
    } catch (err) {
      console.error(err);
      Toast.error(err.message || 'Could not save categorized transactions.');
    } finally {
      setSaving(false);
    }
  }

  const pendingCount = txns.filter((t) => t.status === TXN_STATUS.UNCATEGORIZED).length;

  return (
    <div>
      <SectionCard>
        <div className="field-row" style={{ alignItems: 'flex-end' }}>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Type</label>
            <Tabs items={[{ value: TXN_TYPE.OUTFLOW, label: 'Outflow' }, { value: TXN_TYPE.INFLOW, label: 'Inflow' }, { value: TXN_TYPE.INTERNAL, label: 'Internal' }]}
              value={bulk.type} onChange={(v) => setBulk({ ...bulk, type: v, headId: '', subHeadId: '' })} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Vertical</label>
            <SearchableSelect options={MasterHelpers.verticalOptions(masterData)} value={bulk.verticalId} onChange={(v) => setBulk({ ...bulk, verticalId: v, headId: '', subHeadId: '' })} placeholder="Vertical" />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Head</label>
            <SearchableSelect options={MasterHelpers.headOptions(masterData, bulk.verticalId, bulk.type || null)} value={bulk.headId} onChange={(v) => setBulk({ ...bulk, headId: v, subHeadId: '' })} placeholder="Head" disabled={!bulk.verticalId} />
          </div>
          <div className="field" style={{ marginBottom: 0 }}>
            <label>Sub-head</label>
            <SearchableSelect options={MasterHelpers.subHeadOptions(masterData, bulk.headId)} value={bulk.subHeadId} onChange={(v) => setBulk({ ...bulk, subHeadId: v })} placeholder="Sub-head" disabled={!bulk.headId} />
          </div>
          <button className="btn btn-secondary" onClick={applyBulk}>Apply to filtered ({filtered.length})</button>
        </div>
      </SectionCard>

      <div className="toolbar">
        <Tabs items={[{ value: 'pending', label: `Pending (${pendingCount})` }, { value: 'all', label: 'All Transactions' }]} value={tab} onChange={setTab} />
        <div className="spacer" />
        <input className="input" style={{ maxWidth: 260 }} placeholder="Search particulars / remarks..." value={search} onChange={(e) => setSearch(e.target.value)} />
        <button className="btn btn-primary" onClick={saveAll} disabled={saving || filtered.length === 0}>{saving ? <span className="spinner on-dark"></span> : `Save (${filtered.length} in view)`}</button>
      </div>

      {loading ? <PageLoader /> : filtered.length === 0 ? (
        <EmptyState icon="✅" title="Nothing here" sub="All caught up — no transactions match this view." />
      ) : (
        <React.Fragment>
          <div className="table-wrap">
            <table className="dtable">
              <thead>
                <tr>
                  <th>Date</th><th>Particulars</th><th className="cell-num">Amount</th>
                  <th>Type</th><th>Vertical</th><th>Head</th><th>Sub-head</th><th>Status</th>
                </tr>
              </thead>
              <tbody>
                {pageRows.map((t) => {
                  const canEdit = Auth.canEditTransactionDate(user, t.date, settings);
                  const amt = Utils.netCash(t);
                  return (
                    <tr key={t.id}>
                      <td className="cell-muted">{Utils.formatDate(t.date)}</td>
                      <td>
                        <div>{t.particulars || '—'}</div>
                        {t.remarksBank && <div className="cell-muted" style={{ fontSize: 11.5 }}>{t.remarksBank}</div>}
                        {t.status === TXN_STATUS.CATEGORIZED && t.categorySnapshot && (
                          <div className="cell-muted" style={{ fontSize: 11 }}>
                            Saved: {t.categorySnapshot.verticalName} / {t.categorySnapshot.headName} / {t.categorySnapshot.subHeadName}
                          </div>
                        )}
                      </td>
                      <td className={Utils.classNames('cell-num', amt >= 0 ? 'var-under' : 'var-over')}>{Utils.formatCurrency(amt)}</td>
                      <Categorize_RowSelects draft={drafts[t.id] || emptyDraft()} onChange={(v) => setDraft(t.id, v)} masterData={masterData} disabled={!canEdit} />
                      <td>{t.status === TXN_STATUS.CATEGORIZED
                        ? <Badge tone="success">Categorized</Badge>
                        : canEdit ? <Badge tone="warning">Pending</Badge> : <Badge tone="neutral">Locked</Badge>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="toolbar" style={{ justifyContent: 'flex-end' }}>
            <button className="btn btn-ghost btn-sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>← Prev</button>
            <span className="muted" style={{ fontSize: 12.5 }}>Page {page + 1} of {totalPages}</span>
            <button className="btn btn-ghost btn-sm" disabled={page >= totalPages - 1} onClick={() => setPage((p) => p + 1)}>Next →</button>
          </div>
        </React.Fragment>
      )}
    </div>
  );
}
