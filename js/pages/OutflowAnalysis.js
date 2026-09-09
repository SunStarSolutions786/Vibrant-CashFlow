// ============================================================================
// VIBRANT CashFlow — Outflow Analysis (Vertical / Head / Sub-head, Budget vs
// Booking vs Actual Paid, colour-coded by variance)
// ============================================================================

function varianceBadge(tone, pct) {
  const label = tone === 'over' ? 'Over Budget' : tone === 'near' ? 'Near Limit' : 'Under Budget';
  return <Badge tone={tone === 'over' ? 'danger' : tone === 'near' ? 'warning' : 'success'}>{label}{isFinite(pct) ? ` · ${Math.round(pct * 100)}%` : ''}</Badge>;
}

function collectOutflowCategories(masterData, txns, budgets) {
  const categories = new Map();
  function add(chain, preferSnapshot) {
    const key = MasterHelpers.snapshotKey(chain);
    if (!key || key === '||') return;
    if (!categories.has(key) || preferSnapshot) categories.set(key, { key, chain });
  }

  (masterData.heads || []).forEach((head) => {
    if (!(head.appliesTo === TXN_TYPE.OUTFLOW || head.appliesTo === 'both') || head.group === 'internal') return;
    const vertical = (masterData.verticals || []).find((v) => v.id === head.verticalId);
    (masterData.subHeads || []).filter((s) => s.headId === head.id).forEach((sub) => add({
      verticalId: vertical ? vertical.id : head.verticalId,
      verticalName: vertical ? vertical.name : '',
      headId: head.id,
      headName: head.name,
      subHeadId: sub.id,
      subHeadName: sub.name,
      appliesTo: head.appliesTo,
      group: head.group || 'opex',
    }, false));
  });

  (txns || []).filter((t) => t.type === TXN_TYPE.OUTFLOW && t.status === TXN_STATUS.CATEGORIZED)
    .forEach((t) => add(MasterHelpers.resolveTransactionChain(masterData, t), Boolean(t.categorySnapshot)));
  (budgets || []).forEach((b) => add(MasterHelpers.resolveTransactionChain(masterData, b), Boolean(b.categorySnapshot)));
  return Array.from(categories.values());
}

function outflowRowsForMonths(masterData, txns, budgets, months) {
  const categories = collectOutflowCategories(masterData, txns, budgets);
  const monthSet = new Set(months);
  const paidByKey = new Map();
  const budgetByKey = new Map();

  (txns || []).forEach((t) => {
    if (t.type !== TXN_TYPE.OUTFLOW || t.status !== TXN_STATUS.CATEGORIZED || !monthSet.has(Utils.monthKey(t.date))) return;
    const key = MasterHelpers.snapshotKey(MasterHelpers.resolveTransactionChain(masterData, t));
    paidByKey.set(key, (paidByKey.get(key) || 0) + Utils.netOutflow(t));
  });
  (budgets || []).forEach((b) => {
    if (!monthSet.has(b.month)) return;
    const key = MasterHelpers.snapshotKey(MasterHelpers.resolveTransactionChain(masterData, b));
    const current = budgetByKey.get(key) || { budget: 0, booking: 0 };
    current.budget += Number(b.budget) || 0;
    current.booking += Number(b.booking) || 0;
    budgetByKey.set(key, current);
  });

  return categories.map(({ key, chain }) => {
    const planned = budgetByKey.get(key) || { budget: 0, booking: 0 };
    const paid = paidByKey.get(key) || 0;
    return {
      key,
      verticalId: reportVerticalKey(chain),
      vertical: chain.verticalName || 'Unassigned',
      head: chain.headName || 'Unassigned',
      group: chain.group || 'opex',
      sub: chain.subHeadName || 'Unassigned',
      budget: planned.budget,
      booking: planned.booking,
      paid,
      tone: varianceTone(planned.budget, paid),
    };
  });
}

function OutflowAnalysisPage({ masterData }) {
  const [loading, setLoading] = React.useState(true);
  const [txns, setTxns] = React.useState([]);
  const [budgets, setBudgets] = React.useState([]);
  const [month, setMonth] = React.useState(Utils.monthKey(Utils.todayISO()));
  const [verticalId, setVerticalId] = React.useState('');
  const [groupFilter, setGroupFilter] = React.useState('all');
  const [mode, setMode] = React.useState('month');
  const [availableMonths, setAvailableMonths] = React.useState([]);
  const [loadError, setLoadError] = React.useState('');

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const fromMonth = Utils.addMonths(month, -5);
        const [t, b, months] = await Promise.all([
          DataStore.getTransactions({ fromDate: `${fromMonth}-01`, toDate: `${month}-31`, all: true }),
          DataStore.getBudgets({ fromMonth, toMonth: month, all: true }),
          DataStore.getAvailableMonths(),
        ]);
        if (alive) { setTxns(t); setBudgets(b); setAvailableMonths(months); }
      } catch (err) {
        console.error(err);
        if (alive) {
          const message = DataStore.describeError(err, 'Could not load outflow analysis.');
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

  const outflowAll = txns.filter((t) => t.type === TXN_TYPE.OUTFLOW && t.status === TXN_STATUS.CATEGORIZED);
  const monthOptions = Array.from(new Set([month, ...availableMonths])).filter(Boolean)
    .sort().reverse().map((value) => ({ value, label: Utils.monthLabel(value) }));
  const verticalOptions = reportVerticalOptions(masterData, [...outflowAll, ...budgets]);
  const matchesFilters = (chain) => (!verticalId || reportVerticalKey(chain) === verticalId)
    && (groupFilter === 'all' || (chain.group || 'opex') === groupFilter);

  const rows = outflowRowsForMonths(masterData, txns, budgets, [month])
    .filter((r) => (!verticalId || r.verticalId === verticalId) && (groupFilter === 'all' || r.group === groupFilter))
    .filter((r) => r.budget !== 0 || r.booking !== 0 || r.paid !== 0)
    .sort((a, b) => `${a.vertical}|${a.head}|${a.sub}`.localeCompare(`${b.vertical}|${b.head}|${b.sub}`));
  const grandBudget = Utils.sumBy(rows, (r) => r.budget);
  const grandBooking = Utils.sumBy(rows, (r) => r.booking);
  const grandPaid = Utils.sumBy(rows, (r) => r.paid);
  const pendingCount = txns.filter((t) => t.type === TXN_TYPE.OUTFLOW && t.status === TXN_STATUS.UNCATEGORIZED && Utils.monthKey(t.date) === month).length;

  const trendMonthKeys = Array.from({ length: 6 }, (_, i) => Utils.addMonths(month, i - 5));
  const trend = trendMonthKeys.map((m) => {
    const paid = Utils.sumBy(outflowAll.filter((t) => Utils.monthKey(t.date) === m && matchesFilters(MasterHelpers.resolveTransactionChain(masterData, t))), Utils.netOutflow);
    const bud = Utils.sumBy(budgets.filter((b) => b.month === m && matchesFilters(MasterHelpers.resolveTransactionChain(masterData, b))), (b) => b.budget);
    return { key: m, month: Utils.monthLabel(m), paid, bud };
  });
  const maxTrend = Math.max(1, ...trend.map((t) => Math.max(Math.abs(t.paid), Math.abs(t.bud))));

  return (
    <div>
      <div className="toolbar">
        <Tabs items={[{ value: 'month', label: 'By Month' }, { value: 'trend', label: 'Trend' }]} value={mode} onChange={setMode} />
        <SearchableSelect options={monthOptions} value={month} onChange={(v) => v && setMonth(v)} clearable={false} placeholder={mode === 'trend' ? 'Ending month' : 'Month'} />
        <SearchableSelect options={verticalOptions} value={verticalId} onChange={setVerticalId} placeholder="All Verticals" />
        <Tabs items={[{ value: 'all', label: 'All' }, { value: 'opex', label: 'Opex' }, { value: 'capex', label: 'Capex' }, { value: 'working capital', label: 'Working Capital' }]} value={groupFilter} onChange={setGroupFilter} />
      </div>

      {mode === 'month' ? (
        <React.Fragment>
          <div className="stat-grid">
            <StatCard icon="🎯" label="Budget" value={Utils.formatCurrency(grandBudget)} accent="primary" />
            <StatCard icon="📝" label="Booking" value={Utils.formatCurrency(grandBooking)} accent="primary" />
            <StatCard icon="💸" label="Actual Paid" value={Utils.formatCurrency(grandPaid)} accent={grandPaid > grandBudget ? 'danger' : 'success'} />
            <StatCard icon="⚖️" label="Variance" value={Utils.formatCurrency(grandBudget - grandPaid)} accent={grandBudget - grandPaid >= 0 ? 'success' : 'danger'} />
            <StatCard icon="⚠️" label="Pending outflow (excluded)" value={pendingCount} accent={pendingCount > 0 ? 'warning' : 'success'} />
          </div>

          <SectionCard title={`Outflow — ${Utils.monthLabel(month)}`} sub="Colour-coded by spend against budget: green = under, amber = near limit, red = over">
            {rows.length === 0 ? <EmptyState icon="🎯" title="No budget or spend recorded for this month" sub="Set a budget from Budget & Booking, or categorize some outflow transactions." /> : (
              <div className="table-wrap">
                <table className="dtable">
                  <thead><tr><th>Vertical</th><th>Head</th><th>Group</th><th>Sub-head</th><th className="cell-num">Budget</th><th className="cell-num">Booking</th><th className="cell-num">Paid</th><th>Status</th></tr></thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.key} className={Utils.classNames('bg-' + r.tone)}>
                        <td className="cell-muted">{r.vertical}</td>
                        <td>{r.head}</td>
                        <td>{r.group ? <Badge tone={MasterHelpers.groupTone(r.group)}>{r.group}</Badge> : ''}</td>
                        <td>{r.sub}</td>
                        <td className="cell-num">{Utils.formatCurrency(r.budget)}</td>
                        <td className="cell-num">{Utils.formatCurrency(r.booking)}</td>
                        <td className={Utils.classNames('cell-num', 'var-' + r.tone)}>{Utils.formatCurrency(r.paid)}</td>
                        <td>{varianceBadge(r.tone, r.budget ? r.paid / r.budget : (r.paid > 0 ? Infinity : 0))}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot><tr><td colSpan="4">Total</td><td className="cell-num">{Utils.formatCurrency(grandBudget)}</td><td className="cell-num">{Utils.formatCurrency(grandBooking)}</td><td className="cell-num">{Utils.formatCurrency(grandPaid)}</td><td></td></tr></tfoot>
                </table>
              </div>
            )}
          </SectionCard>
        </React.Fragment>
      ) : (
        <SectionCard title={`Budget vs Actual — six months ending ${Utils.monthLabel(month)}`}>
          {trend.map((t) => (
            <div key={t.key} style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12.5, marginBottom: 5 }}>
                <b>{t.month}</b>
                <span>{Utils.formatCurrency(t.paid)} <span className="cell-muted">/ {Utils.formatCurrency(t.bud)} budget</span></span>
              </div>
              <div className="progress-track"><div className="progress-fill" style={{ width: `${(Math.abs(t.paid) / maxTrend) * 100}%`, background: t.paid > t.bud && t.bud > 0 ? 'var(--danger)' : 'var(--accent)' }}></div></div>
            </div>
          ))}
        </SectionCard>
      )}
    </div>
  );
}
