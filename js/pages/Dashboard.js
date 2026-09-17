// ============================================================================
// VIBRANT CashFlow — Dashboard
// ============================================================================

function DashboardPage({ user, masterData }) {
  const [loading, setLoading] = React.useState(true);
  const [dashboard, setDashboard] = React.useState(null);
  const [loadError, setLoadError] = React.useState('');
  const [review, setReview] = React.useState(null);
  const [confirming, setConfirming] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);

  async function refresh() {
    setRefreshing(true);
    try { setDashboard(await DataStore.getDashboardData(masterData, { fresh: true })); }
    catch (error) { Toast.error(DataStore.describeError(error, 'Could not refresh dashboard data.')); }
    finally { setRefreshing(false); }
  }

  async function confirmBalance(row) {
    if (confirming) return;
    setConfirming(true);
    try {
      await DataStore.confirmBankBalance(row.bankAccountId, row.id, review.date);
      setDashboard(await DataStore.getDashboardData(masterData, { fresh: true }));
      setReview(null); Toast.success('Closing balance confirmed. New or corrected statements will be checked again.');
    } catch (error) { Toast.error(error.message); }
    finally { setConfirming(false); }
  }

  React.useEffect(() => {
    let alive = true;
    setLoading(true);
    setLoadError('');
    (async () => {
      try {
        const result = await DataStore.getDashboardData(masterData);
        if (alive) setDashboard(result);
      } catch (err) {
        console.error(err);
        if (alive) {
          const message = DataStore.describeError(err, 'Could not load dashboard data.');
          setLoadError(message);
          Toast.error(message);
        }
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [masterData]);

  if (loading || !masterData) return <PageLoader />;
  if (loadError) return <EmptyState icon="⚠️" title={loadError} sub="Reload the page to try again." />;
  if (!dashboard) return <EmptyState icon="⚠️" title="Dashboard data is unavailable." sub="Reload the page to try again." />;

  const { totalInflow, totalOutflow, monthInflow, monthOutflow, uncategorized } = dashboard;
  const net = totalInflow - totalOutflow;
  const recent = dashboard.recent || [];
  const latestBalances = (dashboard.latestBalances || []).sort((a, b) => {
    const aName = (a.bankSnapshot && a.bankSnapshot.name) || a.bankName || MasterHelpers.bankAccountName(masterData, a.bankAccountId) || 'Unassigned account';
    const bName = (b.bankSnapshot && b.bankSnapshot.name) || b.bankName || MasterHelpers.bankAccountName(masterData, b.bankAccountId) || 'Unassigned account';
    return aName.localeCompare(bName);
  });

  return (
    <div>
      <div className="toolbar toolbar-end">
        <DataFreshness loadedAt={dashboard.loadedAt} onRefresh={refresh} busy={refreshing} />
      </div>
      <div className="stat-grid">
        <StatCard icon="📈" label="Total Inflow (all-time)" value={Utils.formatCurrency(totalInflow)} accent="success" delta={`${Utils.formatCurrency(monthInflow)} this month`} />
        <StatCard icon="📉" label="Total Outflow (all-time)" value={Utils.formatCurrency(totalOutflow)} accent="danger" delta={`${Utils.formatCurrency(monthOutflow)} this month`} />
        <StatCard icon="💰" label="Net Cash Flow" value={Utils.formatCurrency(net)} accent={net >= 0 ? 'primary' : 'danger'} />
        <StatCard icon="🏷️" label="Awaiting Categorization" value={uncategorized} accent={uncategorized > 0 ? 'warning' : 'success'} />
      </div>

      {latestBalances.length > 0 && (
        <SectionCard title="Latest bank closing balances" sub="Latest statement balance recorded for each account">
          <div className="stat-grid" style={{ marginBottom: 0 }}>
            {latestBalances.map((t) => {
              const accountName = (t.bankSnapshot && t.bankSnapshot.name) || t.bankName || MasterHelpers.bankAccountName(masterData, t.bankAccountId) || 'Unassigned account';
              return <div key={t.bankAccountId || t.bankName || t.id}><StatCard icon="🏦" label={accountName}
                value={t.balanceUncertain ? 'Needs review' : Utils.formatCurrency(Number(t.closingBalance))}
                accent={t.balanceUncertain ? 'warning' : Number(t.closingBalance) >= 0 ? 'primary' : 'danger'}
                delta={t.balanceUncertain ? `Conflicting / unordered statements on ${Utils.formatDate(t.date)}. Review the bank statement before using this balance.` : `As of ${Utils.formatDate(t.date)}${t.balanceConfirmed ? ' · Reviewed' : ''}`} />
                {user.role !== ROLES.VIEWER && <button className="btn btn-secondary btn-sm" style={{ marginTop: 8 }} onClick={() => setReview(t)}>Review closing balance</button>}</div>;
            })}
          </div>
        </SectionCard>
      )}

      {(user.role === ROLES.ADMIN || user.role === ROLES.BACKOFFICE) && (
        <SectionCard title="Quick actions">
          <div className="toolbar" style={{ marginBottom: 0 }}>
            <a className="btn btn-primary" href="#/upload">⬆️ Upload Bank Statement</a>
            <a className="btn btn-secondary" href="#/cashEntry">💵 Add Cash Entry</a>
            {uncategorized > 0 && <a className="btn btn-secondary" href="#/categorize">🏷️ Categorize {uncategorized} pending</a>}
          </div>
        </SectionCard>
      )}

      <SectionCard title="Recent activity" sub="Latest transactions across all accounts">
        {recent.length === 0 ? (
          <EmptyState icon="📭" title="No transactions yet" sub="Upload a bank statement or add a cash entry to get started." />
        ) : (
          <div className="table-wrap">
            <table className="dtable">
              <thead>
                <tr><th>Date</th><th>Particulars</th><th>Vertical / Head</th><th className="cell-num">Amount</th><th>Status</th></tr>
              </thead>
              <tbody>
                {recent.map((t) => {
                  const chain = MasterHelpers.resolveTransactionChain(masterData, t);
                  const amt = Utils.netCash(t);
                  return (
                    <tr key={t.id}>
                      <td>{Utils.formatDate(t.date)}</td>
                      <td>{t.particulars || t.remarksBank || '—'}</td>
                      <td className="cell-muted">{chain.verticalName ? `${chain.verticalName} / ${chain.headName}` : '—'}</td>
                      <td className={Utils.classNames('cell-num', amt >= 0 ? 'var-under' : 'var-over')}>{Utils.formatCurrency(amt)}</td>
                      <td>{t.status === 'void' ? <Badge tone="neutral">Cancelled</Badge> : t.status === TXN_STATUS.CATEGORIZED ? <Badge tone="success">Categorized</Badge> : <Badge tone="warning">Pending</Badge>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </SectionCard>
      {review && <Modal title={`Review bank balance — ${Utils.formatDate(review.date)}`} onClose={() => !confirming && setReview(null)} wide>
        <p className="help-text">Check the bank statement and select the last posted transaction. This confirms the displayed balance; it does not change the transaction amounts.</p>
        <div className="table-wrap" style={{ maxHeight: 450, overflowY: 'auto' }}><table className="dtable"><thead><tr><th>Particulars</th><th>File row / imported</th><th>Closing balance</th><th></th></tr></thead><tbody>
          {(review.balanceCandidates || []).map((r) => <tr key={r.id}><td>{r.particulars}</td><td>{r.statementRowOrder || '—'}<div className="cell-muted">{r.importedAt || r.createdAt}</div></td><td>{Utils.formatCurrency(r.closingBalance)}</td><td><button className="btn btn-primary btn-sm" disabled={confirming} onClick={() => confirmBalance(r)}>Use this closing balance</button></td></tr>)}
        </tbody></table></div>
      </Modal>}
    </div>
  );
}
