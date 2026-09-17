function TransactionEditor({ record, user, masterData, settings, onClose, onSaved }) {
  const [form, setForm] = React.useState({ date: record.date, bankAccountId: record.bankAccountId || '',
    cashVerticalId: record.cashVerticalId || record.verticalId || '', withdrawal: record.withdrawal, deposit: record.deposit,
    closingBalance: record.closingBalance ?? '', particulars: record.particulars || '', reason: '' });
  const [busy, setBusy] = React.useState(false);
  const [historyRows, setHistoryRows] = React.useState([]);
  const [historyError, setHistoryError] = React.useState('');
  const operation = React.useRef(null);
  const [dirty, setDirty] = React.useState(false);
  useUnsavedChanges(dirty);
  const canEdit = Auth.canEditTransactionDate(user, record.date, settings);
  React.useEffect(() => {
    let alive = true;
    DataStore.getTransactionHistory(record.id).then((rows) => { if (alive) setHistoryRows(rows); })
      .catch((error) => { if (alive) setHistoryError(DataStore.describeError(error)); });
    return () => { alive = false; };
  }, [record.id]);
  function set(field, value) { setDirty(true); operation.current = null; setForm((f) => ({ ...f, [field]: value })); }
  function close() { if (!busy && (!dirty || window.confirm('Discard this unsaved correction?'))) onClose(); }
  async function save(cancel) {
    if (busy || !canEdit) return;
    if (!form.reason.trim()) { Toast.error('Enter a reason for this correction or cancellation.'); return; }
    const withdrawal = Utils.parseAmountStrict(form.withdrawal, 0), deposit = Utils.parseAmountStrict(form.deposit, 0);
    const closingBalance = Utils.parseAmountStrict(form.closingBalance, null);
    if (!cancel && (withdrawal == null || deposit == null || withdrawal < 0 || deposit < 0 || withdrawal === deposit
      || (String(form.closingBalance).trim() && closingBalance == null))) { Toast.error('Enter valid amounts.'); return; }
    if (!Auth.canEditTransactionDate(user, form.date, settings)) { Toast.error('The corrected date is outside your edit window.'); return; }
    if (cancel && !window.confirm('Cancel this transaction? It will remain in the audit history and be excluded from totals.')) return;
    setBusy(true);
    try {
      const account = masterData.bankAccounts.find((b) => b.id === form.bankAccountId);
      if (!cancel && record.source === TXN_SOURCE.BANK && !account) throw new Error('Select a current bank account.');
      if (!operation.current) {
        const now = new Date().toISOString();
        const changed = cancel ? { status: 'void' } : {
          ...(record.status === 'void' ? { status: TXN_STATUS.UNCATEGORIZED, verticalId: '', headId: '', subHeadId: '', categorySnapshot: null } : {}),
          date: form.date, withdrawal, deposit, closingBalance,
          particulars: form.particulars.trim(), cashVerticalId: form.cashVerticalId,
          ...(account ? { bankAccountId: account.id, bankName: account.name,
            bankSnapshot: { id: account.id, name: account.name, verticalId: account.verticalId,
              verticalName: MasterHelpers.verticalName(masterData, account.verticalId) } } : {}),
        };
        operation.current = { ...record, ...changed, changeReason: form.reason.trim(), updatedAt: now,
          _expectedRevision: Number(record._revision) || 0, _operationId: Utils.genId('correction') };
      }
      const saved = await DataStore.bulkUpsertTransactions([operation.current]);
      setDirty(false); Toast.success(cancel ? 'Transaction cancelled.' : record.status === 'void' ? 'Transaction restored to Pending.' : 'Correction saved with history.'); onSaved(saved[0]);
    } catch (error) { Toast.error(error.message); }
    finally { setBusy(false); }
  }
  return <Modal title="Transaction details & history" onClose={close} wide footer={<React.Fragment>
    <button className="btn btn-secondary" onClick={close} disabled={busy}>Close</button>
    {canEdit && <React.Fragment>{record.status !== 'void' && <button className="btn btn-danger" disabled={busy} onClick={() => save(true)}>Cancel transaction</button>}
      <button className="btn btn-primary" disabled={busy} onClick={() => save(false)}>{record.status === 'void' ? 'Restore to pending' : 'Save correction'}</button></React.Fragment>}
  </React.Fragment>}>
    <p className="help-text">ID: {record.id} · {record.status === 'void' ? 'Cancelled' : record.status}. Original import identity is retained when correcting a record.</p>
    <fieldset disabled={!canEdit || busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="field-row"><div className="field"><label>Date<input aria-label="Correction date" className="input" type="date" value={form.date} max={Utils.todayISO()} onChange={(e) => set('date', e.target.value)} /></label></div>
        <div className="field"><label>Withdrawal<input aria-label="Correction withdrawal" className="input" type="number" min="0" step="0.01" value={form.withdrawal} onChange={(e) => set('withdrawal', e.target.value)} /></label></div>
        <div className="field"><label>Deposit<input aria-label="Correction deposit" className="input" type="number" min="0" step="0.01" value={form.deposit} onChange={(e) => set('deposit', e.target.value)} /></label></div></div>
      {record.source === TXN_SOURCE.BANK ? <div className="field-row"><div className="field"><label>Bank account</label>
        <SearchableSelect disabled={!canEdit || busy} options={MasterHelpers.bankAccountOptions(masterData)} value={form.bankAccountId} onChange={(v) => set('bankAccountId', v)} placeholder="Bank account" /></div>
        <div className="field"><label>Recorded closing balance<input className="input" type="number" step="0.01" value={form.closingBalance} onChange={(e) => set('closingBalance', e.target.value)} /></label></div></div>
        : <div className="field"><label>Cash business / Vertical</label><SearchableSelect disabled={!canEdit || busy} options={MasterHelpers.verticalOptions(masterData)} value={form.cashVerticalId} onChange={(v) => set('cashVerticalId', v)} placeholder="Cash business" /></div>}
      <div className="field"><label>Particulars<input className="input" value={form.particulars} onChange={(e) => set('particulars', e.target.value)} /></label></div>
      <div className="field"><label>Reason (required)<input aria-label="Correction reason" className="input" value={form.reason} onChange={(e) => set('reason', e.target.value)} /></label></div>
    </fieldset>
    <p><b>Previous versions</b></p>
    {historyError ? <p role="alert" className="error-text">{historyError}</p> : historyRows.length === 0 ? <p className="help-text">No earlier corrections recorded.</p> : <div className="table-wrap"><table className="dtable"><thead><tr><th>Previous date</th><th>Particulars</th><th>Withdrawal</th><th>Deposit</th><th>Reason / user</th></tr></thead>
      <tbody>{historyRows.map((h) => <tr key={h.id}><td>{Utils.formatDate(h.before.date)}</td><td>{h.before.particulars}</td><td>{Utils.formatCurrency(h.before.withdrawal)}</td><td>{Utils.formatCurrency(h.before.deposit)}</td><td>{h.reason}<div className="cell-muted">{h.actor}</div></td></tr>)}</tbody></table></div>}
  </Modal>;
}
