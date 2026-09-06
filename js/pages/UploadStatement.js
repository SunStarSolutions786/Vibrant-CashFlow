// ============================================================================
// VIBRANT CashFlow — Statement (bulk upload + single manual entry)
//
// Expects the standard consolidated bank-statement format:
// Bank Name | Date | Particulars | Particulars2 | Withdrawal Amt. | Deposit Amt. | Closing Balance | Remarks
// ============================================================================

function normHeader(s) { return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]/g, ''); }

const STMT_COLUMNS = {
  bankname: 'bankName', date: 'date', particulars: 'particulars', particulars2: 'particulars2',
  withdrawalamt: 'withdrawal', depositamt: 'deposit', closingbalance: 'closingBalance',
  // Accept both the template's "Remarks" and the raw bank-export "Remarks_Manual".
  remarks: 'remarksBank', remarksmanual: 'remarksBank',
  vertical: 'vertical', head: 'head', subhead: 'subHead',
  flow: 'flow', flowinflowoutflowboth: 'flow',
  group: 'group', groupcapexopexworkingcapitalinternal: 'group',
};

function parseStatementWorkbook(workbook) {
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }) : [];
  if (rows.length < 2) return { rows: [], missing: ['(sheet is empty)'], issues: [], blankRows: 0 };

  const headerMap = {}; // colIndex -> field
  const duplicateFields = [];
  const seenFields = new Set();
  rows[0].forEach((h, i) => {
    const key = STMT_COLUMNS[normHeader(h)];
    if (!key) return;
    if (seenFields.has(key)) duplicateFields.push(key);
    else { seenFields.add(key); headerMap[i] = key; }
  });

  const required = ['bankName', 'date', 'withdrawal', 'deposit'];
  const requiredLabels = { bankName: 'Bank Name', date: 'Date', withdrawal: 'Withdrawal Amt.', deposit: 'Deposit Amt.' };
  const found = new Set(Object.values(headerMap));
  const classificationHeadersPresent = ['vertical', 'head', 'subHead', 'flow', 'group'].every((field) => found.has(field));
  const missing = required.filter((r) => !found.has(r)).map((r) => requiredLabels[r]);
  duplicateFields.forEach((field) => missing.push(`Duplicate column: ${requiredLabels[field] || field}`));
  if (missing.length) return { rows: [], missing, issues: [], blankRows: 0 };

  const parsed = [];
  const issues = [];
  let blankRows = 0;
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.every((c) => c == null || String(c).trim() === '')) { blankRows++; continue; }
    const rec = {
      bankName: '', particulars: '', particulars2: '', withdrawal: 0, deposit: 0,
      closingBalance: null, remarksBank: '', date: '',
      vertical: '', head: '', subHead: '', flow: '', group: '',
      _classificationHeadersPresent: classificationHeadersPresent,
    };
    const errors = [];
    Object.entries(headerMap).forEach(([idx, field]) => {
      const val = row[idx];
      if (field === 'date') {
        rec.date = Utils.toISODate(Utils.parseFlexibleDate(val));
      } else if (field === 'withdrawal' || field === 'deposit') {
        const amount = Utils.parseAmountStrict(val, 0);
        if (amount == null) errors.push(`${field === 'withdrawal' ? 'Withdrawal' : 'Deposit'} is not a valid amount`);
        else if (amount < 0) errors.push(`${field === 'withdrawal' ? 'Withdrawal' : 'Deposit'} cannot be negative`);
        else rec[field] = amount;
      } else if (field === 'closingBalance') {
        const balance = Utils.parseAmountStrict(val, null);
        if (val != null && String(val).trim() !== '' && balance == null) errors.push('Closing Balance is not a valid amount');
        else rec.closingBalance = balance;
      }
      else rec[field] = String(val || '').trim();
    });

    if (!rec.bankName) errors.push('Bank Name is required');
    if (!rec.date) errors.push('Date is missing or invalid');
    else if (rec.date > Utils.todayISO()) errors.push('Date cannot be in the future');
    if (Utils.netCash(rec) === 0) errors.push('Withdrawal and Deposit have a zero net value');
    if (errors.length) {
      issues.push({ row: r + 1, message: errors.join('; ') });
      continue;
    }
    parsed.push(rec);
  }
  return { rows: parsed, missing: [], issues, blankRows };
}

function canonicalStatementRow(rec, bankAccountId) {
  return Utils.canonicalStatementRow(rec, bankAccountId);
}

async function statementImportHash(canonical, occurrence) {
  return Utils.statementImportHash(canonical, occurrence);
}

function UploadStatementPage({ user, masterData }) {
  const [mode, setMode] = React.useState('add');
  const [fileName, setFileName] = React.useState('');
  const [parsedRows, setParsedRows] = React.useState(null);
  const [missing, setMissing] = React.useState([]);
  const [parseReport, setParseReport] = React.useState({ issues: [], blankRows: 0 });
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [allowExactDuplicates, setAllowExactDuplicates] = React.useState(false);
  const fileRef = React.useRef(null);

  async function onFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setResult(null);
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array', cellDates: false });
      const parsed = parseStatementWorkbook(wb);
      setMissing(parsed.missing);
      setParseReport({ issues: parsed.issues, blankRows: parsed.blankRows });
      setParsedRows(parsed.missing.length ? null : parsed.rows);
    } catch (err) {
      console.error(err);
      Toast.error('Could not read that file. Please upload a valid .xlsx statement.');
      setParsedRows(null);
      setMissing([]);
      setParseReport({ issues: [], blankRows: 0 });
    } finally {
      setBusy(false);
      // Allows the same corrected file to be selected again immediately.
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function commitImport() {
    if (!parsedRows || parsedRows.length === 0) {
      Toast.error('There are no valid rows to import.');
      return;
    }
    setBusy(true);
    try {
      const accountByName = new Map((masterData.bankAccounts || []).map((account) => [account.name.trim().toLowerCase(), account]));
      const unknownAccounts = Array.from(new Set(parsedRows
        .map((row) => row.bankName.trim())
        .filter((name) => !accountByName.has(name.toLowerCase()))));
      if (unknownAccounts.length) {
        throw new Error(`Add or import these Bank Accounts in Master Data first: ${unknownAccounts.slice(0, 5).join(', ')}${unknownAccounts.length > 5 ? '…' : ''}`);
      }
      const occurrenceByRow = new Map();
      const groupKeyByRow = new Map();
      const toInsert = [];
      const importBatchId = Utils.genId('stmtbatch');
      const importedAt = new Date().toISOString();

      for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex++) {
        const rec = parsedRows[rowIndex];
        const acct = accountByName.get(rec.bankName.trim().toLowerCase());
        const canonical = canonicalStatementRow(rec, acct.id);
        const occurrence = (occurrenceByRow.get(canonical) || 0) + 1;
        occurrenceByRow.set(canonical, occurrence);
        const hash = await statementImportHash(canonical, occurrence);
        let importGroupKey = groupKeyByRow.get(canonical);
        if (!importGroupKey) {
          importGroupKey = await Utils.importGroupKey('statement-v3', canonical);
          groupKeyByRow.set(canonical, importGroupKey);
        }
        const bankSnapshot = {
          id: acct.id, name: acct.name, verticalId: acct.verticalId,
          verticalName: MasterHelpers.verticalName(masterData, acct.verticalId),
        };
        const classification = MasterHelpers.matchImportedClassification(masterData, rec);
        const type = classification.matched
          ? classification.type
          : (Utils.netCash(rec) > 0 ? TXN_TYPE.INFLOW : TXN_TYPE.OUTFLOW);

        toInsert.push({
          id: Utils.genId('txn'),
          date: rec.date,
          source: TXN_SOURCE.BANK,
          bankAccountId: acct.id,
          bankName: acct.name,
          bankSnapshot,
          type,
          verticalId: classification.matched ? classification.selection.verticalId : '',
          headId: classification.matched ? classification.selection.headId : '',
          subHeadId: classification.matched ? classification.selection.subHeadId : '',
          categorySnapshot: classification.matched ? classification.snapshot : undefined,
          withdrawal: rec.withdrawal, deposit: rec.deposit, closingBalance: rec.closingBalance,
          particulars: rec.particulars, particulars2: rec.particulars2, remarksBank: rec.remarksBank,
          status: classification.matched ? TXN_STATUS.CATEGORIZED : TXN_STATUS.UNCATEGORIZED,
          importHash: hash,
          importGroupKey,
          importOccurrence: occurrence,
          importHashVersion: 3,
          importBatchId,
          statementRowOrder: rowIndex + 1,
          importedAt,
          createdBy: user.id, createdAt: importedAt, updatedAt: importedAt,
        });
      }

      const imported = await DataStore.importTransactions(toInsert, { allowDuplicates: allowExactDuplicates });
      const storedIds = new Set(imported.transactions.map((item) => item.id));
      const insertedRows = toInsert.filter((item) => storedIds.has(item.id));

      setResult({
        created: imported.inserted,
        categorized: insertedRows.filter((item) => item.status === TXN_STATUS.CATEGORIZED).length,
        pending: insertedRows.filter((item) => item.status === TXN_STATUS.UNCATEGORIZED).length,
        skipped: imported.duplicates,
        acceptedDuplicates: imported.acceptedDuplicates,
        newAccounts: 0,
        rejected: parseReport.issues.length,
      });
      setParsedRows(null);
      setFileName('');
      setAllowExactDuplicates(false);
      Toast.success(`Imported ${imported.inserted} transaction${imported.inserted === 1 ? '' : 's'}; ${insertedRows.filter((item) => item.status === TXN_STATUS.CATEGORIZED).length} categorized, ${insertedRows.filter((item) => item.status === TXN_STATUS.UNCATEGORIZED).length} pending${imported.acceptedDuplicates ? `; ${imported.acceptedDuplicates} reviewed duplicate(s) accepted` : ''}${imported.duplicates ? `; ${imported.duplicates} duplicate(s) skipped` : ''}.`);
    } catch (err) {
      console.error(err);
      Toast.error(err.message || 'The statement could not be imported. No rows were saved.');
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const headers = ['Bank Name', 'Date', 'Particulars', 'Particulars2', 'Withdrawal Amt.', 'Deposit Amt.', 'Closing Balance', 'Remarks', 'Vertical', 'Head', 'Sub-head', 'Flow', 'Group'];
    const ws = XLSX.utils.aoa_to_sheet([headers]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Statement');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    Utils.downloadBlob(new Blob([out], { type: 'application/octet-stream' }), 'Bank Statement Template.xlsx');
  }

  return (
    <div>
      <div className="toolbar">
        <Tabs items={[{ value: 'add', label: '+ Add Entry' }, { value: 'upload', label: '⬆️ Upload File' }]} value={mode} onChange={setMode} />
      </div>

      {mode === 'add' ? (
        <StatementAddEntry user={user} masterData={masterData} />
      ) : (
        <React.Fragment>
          <SectionCard>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <label className={Utils.classNames('btn btn-primary', busy && 'disabled')} style={{ cursor: busy ? 'not-allowed' : 'pointer' }} tabIndex={busy ? -1 : 0}
                onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current && fileRef.current.click(); } }}>
                📄 Choose File
                <input ref={fileRef} className="visually-hidden" tabIndex="-1" type="file" accept=".xlsx,.xls" onChange={onFile} disabled={busy} />
              </label>
              <button type="button" className="btn btn-secondary" onClick={downloadTemplate} disabled={busy}>⬇️ Download Template</button>
              {fileName && <span className="chip">{fileName}</span>}
              {busy && <span className="spinner"></span>}
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, maxWidth: 720 }}>
              <input
                type="checkbox"
                checked={allowExactDuplicates}
                onChange={(e) => setAllowExactDuplicates(e.target.checked)}
                disabled={busy}
                style={{ marginTop: 3 }}
              />
              <span>
                Import exact duplicate rows too
                <span className="help-text" style={{ display: 'block' }}>Use only after reviewing the file. Accepted copies are marked separately for audit.</span>
              </span>
            </label>

            {missing.length > 0 && (
              <div className="error-text" role="alert">
                This file has header issue(s): {missing.join(', ')}. Please match the standard template.
              </div>
            )}

            {parseReport.issues.length > 0 && (
              <div style={{ marginTop: 14 }} role="status" aria-live="polite">
                <Badge tone="warning">{parseReport.issues.length} invalid row(s) skipped</Badge>
                <div className="help-text" style={{ marginTop: 8 }}>
                  {parseReport.issues.slice(0, 8).map((issue) => (
                    <div key={issue.row}>Row {issue.row}: {issue.message}</div>
                  ))}
                  {parseReport.issues.length > 8 && <div>…and {parseReport.issues.length - 8} more invalid row(s).</div>}
                </div>
              </div>
            )}

            {result && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }} role="status" aria-live="polite">
                <Badge tone="success">{result.created} imported</Badge>
                {result.categorized > 0 && <Badge tone="success">{result.categorized} auto-categorized</Badge>}
                {result.pending > 0 && <Badge tone="warning">{result.pending} pending</Badge>}
                {result.acceptedDuplicates > 0 && <Badge tone="info">{result.acceptedDuplicates} reviewed duplicate(s) accepted</Badge>}
                {result.skipped > 0 && <Badge tone="neutral">{result.skipped} duplicates skipped</Badge>}
                {result.rejected > 0 && <Badge tone="warning">{result.rejected} invalid rows skipped</Badge>}
                {result.newAccounts > 0 && <Badge tone="info">{result.newAccounts} new bank account(s) added</Badge>}
                {result.pending > 0 && <a className="btn btn-sm btn-secondary" href="#/categorize">Go to Categorize →</a>}
              </div>
            )}
          </SectionCard>

          {parsedRows && parsedRows.length > 0 && (
            <SectionCard
              title={`Preview — ${parsedRows.length} row(s) found`}
              actions={<button className="btn btn-accent" onClick={commitImport} disabled={busy}>{busy ? <span className="spinner on-dark"></span> : `Import ${parsedRows.length} row(s)`}</button>}
            >
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                <table className="dtable">
                  <thead><tr><th>Bank</th><th>Date</th><th>Particulars</th><th className="cell-num">Withdrawal</th><th className="cell-num">Deposit</th><th className="cell-num">Closing Balance</th><th>Remarks</th><th>Master classification</th><th>Status after import</th></tr></thead>
                  <tbody>
                    {parsedRows.slice(0, 200).map((r, i) => {
                      const classification = MasterHelpers.matchImportedClassification(masterData, r);
                      return <tr key={i}>
                        <td>{r.bankName || '—'}</td>
                        <td>{Utils.formatDate(r.date)}</td>
                        <td>{r.particulars}</td>
                        <td className="cell-num">{r.withdrawal ? Utils.formatCurrency(r.withdrawal) : ''}</td>
                        <td className="cell-num">{r.deposit ? Utils.formatCurrency(r.deposit) : ''}</td>
                        <td className="cell-num">{r.closingBalance == null ? '' : Utils.formatCurrency(r.closingBalance)}</td>
                        <td className="cell-muted">{r.remarksBank}</td>
                        <td className="cell-muted">{[r.vertical, r.head, r.subHead, r.flow, r.group].filter(Boolean).join(' / ') || '—'}</td>
                        <td>{classification.matched ? <Badge tone="success">Categorized</Badge> : <Badge tone="warning">Pending</Badge>}</td>
                      </tr>;
                    })}
                  </tbody>
                </table>
              </div>
              {parsedRows.length > 200 && <p className="help-text">Showing first 200 of {parsedRows.length} rows.</p>}
            </SectionCard>
          )}
        </React.Fragment>
      )}
    </div>
  );
}

function StatementAddEntry({ user, masterData }) {
  const blank = { date: Utils.todayISO(), bankAccountId: '', type: TXN_TYPE.OUTFLOW, amount: '', particulars: '' };
  const [form, setForm] = React.useState(blank);
  const [busy, setBusy] = React.useState(false);

  function set(field, val) { setForm((f) => ({ ...f, [field]: val })); }

  async function submit(e) {
    e.preventDefault();
    const date = Utils.toISODate(Utils.parseFlexibleDate(form.date));
    const amount = Utils.parseAmountStrict(form.amount);
    if (!date || date > Utils.todayISO() || !form.bankAccountId || amount == null || amount <= 0) {
      Toast.error('Please enter a valid date, select a bank account and enter a positive amount.');
      return;
    }
    setBusy(true);
    try {
      const account = (masterData.bankAccounts || []).find((item) => item.id === form.bankAccountId);
      if (!account) throw new Error('The selected Bank Account no longer exists.');
      const txn = {
        id: Utils.genId('txn'),
        date,
        source: TXN_SOURCE.BANK,
        bankAccountId: form.bankAccountId,
        bankName: account.name,
        bankSnapshot: { id: account.id, name: account.name, verticalId: account.verticalId, verticalName: MasterHelpers.verticalName(masterData, account.verticalId) },
        type: form.type,
        verticalId: '', headId: '', subHeadId: '',
        withdrawal: form.type === TXN_TYPE.OUTFLOW ? amount : 0,
        deposit: form.type === TXN_TYPE.INFLOW ? amount : 0,
        particulars: form.particulars || 'Manual entry',
        particulars2: '', remarksBank: '',
        status: TXN_STATUS.UNCATEGORIZED,
        createdBy: user.id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
      await DataStore.bulkUpsertTransactions([txn]);
      setForm(blank);
      Toast.success('Entry saved — categorize it from the Categorize page.');
    } catch (err) {
      console.error(err);
      Toast.error('The entry could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <SectionCard>
      <form onSubmit={submit}>
        <div className="field-row">
          <div className="field">
            <label htmlFor="statement-entry-date">Date</label>
            <input id="statement-entry-date" className="input" type="date" required value={form.date} onChange={(e) => set('date', e.target.value)} max={Utils.todayISO()} />
          </div>
          <div className="field">
            <label>Bank Account</label>
            <SearchableSelect ariaLabel="Bank Account" options={MasterHelpers.bankAccountOptions(masterData)} value={form.bankAccountId} onChange={(v) => set('bankAccountId', v)} placeholder="Select account" />
          </div>
          <div className="field">
            <label>Type</label>
            <Tabs items={[{ value: TXN_TYPE.OUTFLOW, label: 'Outflow' }, { value: TXN_TYPE.INFLOW, label: 'Inflow' }]} value={form.type} onChange={(v) => set('type', v)} />
          </div>
          <div className="field">
            <label htmlFor="statement-entry-amount">Amount (₹)</label>
            <input id="statement-entry-amount" className="input" type="number" required min="0.01" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="statement-entry-particulars">Particulars</label>
          <input id="statement-entry-particulars" className="input" value={form.particulars} onChange={(e) => set('particulars', e.target.value)} placeholder="Optional note" />
        </div>
        <button className="btn btn-primary" type="submit" disabled={busy}>{busy ? <span className="spinner on-dark"></span> : 'Save Entry'}</button>
      </form>
    </SectionCard>
  );
}
