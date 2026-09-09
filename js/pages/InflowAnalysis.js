// ============================================================================
// VIBRANT CashFlow — Inflow Analysis
// ============================================================================

function reportVerticalKey(chain) {
  const item = chain || {};
  const id = String(item.verticalId || '').trim();
  const name = String(item.verticalName || '').trim();
  return id || name ? JSON.stringify([id, name]) : '';
}

function reportVerticalOptions(masterData, records) {
  const map = new Map((masterData.verticals || []).map((vertical) => {
    const value = reportVerticalKey({ verticalId: vertical.id, verticalName: vertical.name });
    return [value, { value, label: vertical.name }];
  }));
  (records || []).forEach((t) => {
    const chain = MasterHelpers.resolveTransactionChain(masterData, t);
    const value = reportVerticalKey(chain);
    if (value && !map.has(value)) map.set(value, { value, label: chain.verticalName || 'Deleted / unnamed vertical' });
  });
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label));
}

function InflowAnalysisPage({ masterData }) {
  const [loading, setLoading] = React.useState(true);
  const [txns, setTxns] = React.useState([]);
  const [month, setMonth] = React.useState(Utils.monthKey(Utils.todayISO()));
  const [availableMonths, setAvailableMonths] = React.useState([]);
  const [verticalId, setVerticalId] = React.useState('');
  const [tab, setTab] = React.useState('summary');
  const [loadError, setLoadError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const [list, months] = await Promise.all([
          DataStore.getTransactions({ fromDate: `${month}-01`, toDate: `${month}-31`, all: true }),
          DataStore.getAvailableMonths(),
        ]);
        if (alive) { setTxns(list); setAvailableMonths(months); }
      } catch (err) {
        console.error(err);
        if (alive) {
          const message = DataStore.describeError(err, 'Could not load inflow analysis.');
          setLoadError(message);
          Toast.error(message);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [month]);

  if (loading || !masterData) return <PageLoader />;
  if (loadError) return <EmptyState icon="⚠️" title={loadError} sub="Reload the page to try again." />;

  const monthOptions = Array.from(new Set([month, ...availableMonths])).filter(Boolean)
    .sort().reverse().map((value) => ({ value, label: Utils.monthLabel(value) }));
  const matchMonth = (t) => Utils.monthKey(t.date) === month;
  const matchVertical = (t) => !verticalId || reportVerticalKey(MasterHelpers.resolveTransactionChain(masterData, t)) === verticalId;

  const inflowAll = txns.filter((t) => t.type === TXN_TYPE.INFLOW && t.status === TXN_STATUS.CATEGORIZED);
  const inflow = inflowAll.filter((t) => matchMonth(t) && matchVertical(t));
  const uncategorizedCount = txns.filter((t) => t.type === TXN_TYPE.INFLOW && t.status === TXN_STATUS.UNCATEGORIZED && matchMonth(t) && matchVertical(t)).length;
  const internal = txns.filter((t) => t.type === TXN_TYPE.INTERNAL && t.status === TXN_STATUS.CATEGORIZED && matchMonth(t) && matchVertical(t));

  const total = Utils.sumBy(inflow, Utils.netCash);
  const byHead = new Map();
  const bySubHead = new Map();
  inflow.forEach((t) => {
    const chain = MasterHelpers.resolveTransactionChain(masterData, t);
    const headKey = MasterHelpers.snapshotKey({ ...chain, subHeadId: '', subHeadName: '' });
    const subKey = MasterHelpers.snapshotKey(chain);
    if (!byHead.has(headKey)) byHead.set(headKey, { chain, list: [] });
    if (!bySubHead.has(subKey)) bySubHead.set(subKey, { chain, list: [] });
    byHead.get(headKey).list.push(t);
    bySubHead.get(subKey).list.push(t);
  });
  const byDate = Utils.groupBy(inflow, (t) => t.date);

  const headRows = Array.from(byHead.entries()).map(([headKey, entry]) => ({
    headId: headKey, name: entry.chain.headName || 'Unassigned',
    vertical: entry.chain.verticalName || 'Unassigned',
    total: Utils.sumBy(entry.list, Utils.netCash), count: entry.list.length,
  })).sort((a, b) => b.total - a.total);

  const subHeadRows = Array.from(bySubHead.entries()).map(([subId, entry]) => ({
    subId, name: entry.chain.subHeadName || 'Unassigned',
    head: entry.chain.headName || 'Unassigned',
    total: Utils.sumBy(entry.list, Utils.netCash), count: entry.list.length,
  })).sort((a, b) => b.total - a.total);

  const dateRows = Object.entries(byDate).map(([date, list]) => ({ date, total: Utils.sumBy(list, Utils.netCash), count: list.length }))
    .sort((a, b) => b.date.localeCompare(a.date));

  const maxHead = Math.max(1, ...headRows.map((r) => Math.abs(r.total)));
  const verticalOptions = reportVerticalOptions(masterData, txns.filter((t) => t.status === TXN_STATUS.CATEGORIZED));

  return (
    <div>
      <div className="toolbar">
        <SearchableSelect options={monthOptions} value={month} onChange={(v) => v && setMonth(v)} placeholder="Month" clearable={false} />
        <SearchableSelect options={verticalOptions} value={verticalId} onChange={setVerticalId} placeholder="All Verticals" />
        <div className="spacer" />
        <Tabs items={[{ value: 'summary', label: 'Summary' }, { value: 'headwise', label: 'Head-wise' }, { value: 'datewise', label: 'Date-wise' }, { value: 'internal', label: `Internal Transfers (${internal.length})` }]} value={tab} onChange={setTab} />
      </div>

      <div className="stat-grid">
        <StatCard icon="📈" label="Total Inflow" value={Utils.formatCurrency(total)} accent="success" />
        <StatCard icon="🧾" label="Entries" value={inflow.length} accent="primary" />
        <StatCard icon="🗂️" label="Distinct Heads" value={headRows.length} accent="primary" />
        <StatCard icon="⚠️" label="Pending inflow (excluded)" value={uncategorizedCount} accent={uncategorizedCount > 0 ? 'warning' : 'success'} />
      </div>

      {tab === 'summary' && (
        <SectionCard title="Inflow by Head" sub="Share of total collection by classification head">
          {headRows.length === 0 ? <EmptyState icon="📭" title="No categorized inflow in this range" /> : (
            <div>
              {headRows.map((r) => (
                <div key={r.headId} style={{ marginBottom: 14 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5 }}>
                    <span><b>{r.name}</b> <span className="cell-muted">· {r.vertical}</span></span>
                    <span>{Utils.formatCurrency(r.total)}</span>
                  </div>
                  <div className="progress-track"><div className="progress-fill" style={{ width: `${(Math.abs(r.total) / maxHead) * 100}%`, background: r.total < 0 ? 'var(--danger)' : 'var(--accent)' }}></div></div>
                </div>
              ))}
            </div>
          )}
        </SectionCard>
      )}

      {tab === 'headwise' && (
        <SectionCard title="Head / Sub-head breakdown">
          <div className="table-wrap">
            <table className="dtable">
              <thead><tr><th>Head</th><th>Sub-head</th><th className="cell-num">Entries</th><th className="cell-num">Total</th></tr></thead>
              <tbody>
                {subHeadRows.map((r) => (
                  <tr key={r.subId}><td className="cell-muted">{r.head}</td><td>{r.name}</td><td className="cell-num">{r.count}</td><td className="cell-num">{Utils.formatCurrency(r.total)}</td></tr>
                ))}
              </tbody>
              <tfoot><tr><td colSpan="3">Total</td><td className="cell-num">{Utils.formatCurrency(total)}</td></tr></tfoot>
            </table>
          </div>
        </SectionCard>
      )}

      {tab === 'datewise' && (
        <SectionCard title="Day-wise collection">
          <div className="table-wrap" style={{ maxHeight: 520, overflowY: 'auto' }}>
            <table className="dtable">
              <thead><tr><th>Date</th><th className="cell-num">Entries</th><th className="cell-num">Total</th></tr></thead>
              <tbody>
                {dateRows.map((r) => (<tr key={r.date}><td>{Utils.formatDate(r.date)}</td><td className="cell-num">{r.count}</td><td className="cell-num">{Utils.formatCurrency(r.total)}</td></tr>))}
              </tbody>
            </table>
          </div>
        </SectionCard>
      )}

      {tab === 'internal' && (
        <SectionCard title="Internal transfers" sub="Moved between group accounts — excluded from Inflow / Outflow totals">
          {internal.length === 0 ? <EmptyState icon="🔁" title="No internal transfers in this range" /> : (
            <div className="table-wrap">
              <table className="dtable">
                <thead><tr><th>Date</th><th>Particulars</th><th>Vertical / Head</th><th className="cell-num">Amount</th></tr></thead>
                <tbody>
                  {internal.map((t) => {
                    const chain = MasterHelpers.resolveTransactionChain(masterData, t);
                    const amount = Utils.netCash(t);
                    return (
                      <tr key={t.id}>
                        <td>{Utils.formatDate(t.date)}</td>
                        <td>{t.particulars || t.remarksBank}</td>
                        <td className="cell-muted">{chain.verticalName} / {chain.headName}</td>
                        <td className={Utils.classNames('cell-num', amount >= 0 ? 'var-under' : 'var-over')}>{Utils.formatCurrency(amount)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SectionCard>
      )}
    </div>
  );
}
