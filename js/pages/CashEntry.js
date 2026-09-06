// ============================================================================
// VIBRANT CashFlow — Cash Entry (uncategorized manual entry + file upload)
// ============================================================================

function normalizedCashText(value) {
  return String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
}

function cashTypeFromValue(value) {
  const type = normalizedCashText(value);
  if (['outflow', 'out', 'cash out', 'withdrawal'].includes(type)) return TXN_TYPE.OUTFLOW;
  if (['inflow', 'in', 'cash in', 'deposit'].includes(type)) return TXN_TYPE.INFLOW;
  return '';
}

function cashHeaderKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const CASH_IMPORT_COLUMNS = {
  date: 'date', dateyyyymmdd: 'date',
  type: 'type', typeoutflowinflow: 'type', typeoutflowinflowinternal: 'type',
  amount: 'amount', particulars: 'particulars', remarks: 'particulars',
  vertical: 'vertical', head: 'head', subhead: 'subHead',
  flow: 'flow', flowinflowoutflowboth: 'flow',
  group: 'group', groupcapexopexworkingcapitalinternal: 'group',
};

function parseCashWorkbook(workbook, canUseDate) {
  const sheetName = workbook.SheetNames[0];
  const ws = workbook.Sheets[sheetName];
  const rows = ws ? XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true }) : [];
  if (rows.length < 2) return { rows: [], missing: ['(sheet is empty)'], issues: [], blankRows: 0 };

  const headerMap = {};
  const duplicateFields = [];
  const seenFields = new Set();
  rows[0].forEach((header, index) => {
    const field = CASH_IMPORT_COLUMNS[cashHeaderKey(header)];
    if (!field) return;
    if (seenFields.has(field)) duplicateFields.push(field);
    else { seenFields.add(field); headerMap[index] = field; }
  });

  const required = ['date', 'type', 'amount'];
  const labels = { date: 'Date', type: 'Type (Outflow/Inflow)', amount: 'Amount' };
  const found = new Set(Object.values(headerMap));
  const classificationHeadersPresent = ['vertical', 'head', 'subHead', 'flow', 'group'].every((field) => found.has(field));
  const missing = required.filter((field) => !found.has(field)).map((field) => labels[field]);
  duplicateFields.forEach((field) => missing.push(`Duplicate column: ${labels[field] || field}`));
  if (missing.length) return { rows: [], missing, issues: [], blankRows: 0 };

  const parsed = [];
  const issues = [];
  let blankRows = 0;
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    if (row.every((value) => value == null || String(value).trim() === '')) { blankRows++; continue; }
    const record = {
      date: '', type: '', amount: null, particulars: '',
      vertical: '', head: '', subHead: '', flow: '', group: '',
      _classificationHeadersPresent: classificationHeadersPresent,
    };
    Object.entries(headerMap).forEach(([index, field]) => {
      const value = row[index];
      if (field === 'date') record.date = Utils.toISODate(Utils.parseFlexibleDate(value));
      else if (field === 'type') record.type = cashTypeFromValue(value);
      else if (field === 'amount') record.amount = Utils.parseAmountStrict(value);
      else record[field] = String(value || '').trim();
    });

    const errors = [];
    if (!record.date) errors.push('Date is missing or invalid');
    else if (record.date > Utils.todayISO()) errors.push('Date cannot be in the future');
    else if (typeof canUseDate === 'function' && !canUseDate(record.date)) errors.push('Date is outside your permitted cash-entry edit window');
    if (!record.type) errors.push('Type must be Outflow or Inflow');
    if (record.amount == null || record.amount <= 0) errors.push('Amount must be a positive number');
    if (errors.length) {
      issues.push({ row: rowIndex + 1, message: errors.join('; ') });
      continue;
    }
    record.particulars = record.particulars || 'Cash entry';
    record.withdrawal = record.type === TXN_TYPE.OUTFLOW ? record.amount : 0;
    record.deposit = record.type === TXN_TYPE.INFLOW ? record.amount : 0;
    parsed.push(record);
  }
  return { rows: parsed, missing: [], issues, blankRows };
}

function canonicalCashRow(rec) {
  return Utils.canonicalCashRow(rec);
}

async function cashImportHash(canonical, occurrence) {
  return Utils.cashImportHash(canonical, occurrence);
}

function CashEntryPage({ user, masterData, settings }) {
  const [mode, setMode] = React.useState('add');
  const blank = { date: Utils.todayISO(), type: TXN_TYPE.OUTFLOW, amount: '', particulars: '' };
  const [form, setForm] = React.useState(blank);
  const [saving, setSaving] = React.useState(false);
  const [fileName, setFileName] = React.useState('');
  const [parsedRows, setParsedRows] = React.useState(null);
  const [missing, setMissing] = React.useState([]);
  const [parseReport, setParseReport] = React.useState({ issues: [], blankRows: 0 });
  const [uploadBusy, setUploadBusy] = React.useState(false);
  const [uploadResult, setUploadResult] = React.useState(null);
  const [allowUploadDuplicates, setAllowUploadDuplicates] = React.useState(false);
  const fileRef = React.useRef(null);

  function set(field, value) { setForm((current) => ({ ...current, [field]: value })); }

  async function submit(e) {
    e.preventDefault();
    const date = Utils.toISODate(Utils.parseFlexibleDate(form.date));
    const amount = Utils.parseAmountStrict(form.amount);
    if (!date || date > Utils.todayISO() || amount == null || amount <= 0) {
      Toast.error('Please enter a valid date and positive amount.');
      return;
    }
    if (!Auth.canEditTransactionDate(user, date, settings)) {
      Toast.error('This date is outside your permitted cash-entry edit window. Ask an Administrator to add this historical entry.');
      return;
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      await DataStore.bulkUpsertTransactions([{
        id: Utils.genId('txn'), date, source: TXN_SOURCE.CASH, bankAccountId: '',
        type: form.type, verticalId: '', headId: '', subHeadId: '',
        withdrawal: form.type === TXN_TYPE.OUTFLOW ? amount : 0,
        deposit: form.type === TXN_TYPE.INFLOW ? amount : 0,
        particulars: form.particulars.trim() || 'Cash entry', particulars2: '', remarksBank: '',
        status: TXN_STATUS.UNCATEGORIZED,
        createdBy: user.id, createdAt: now, updatedAt: now,
      }]);
      setForm(blank);
      Toast.success('Cash entry saved — categorize it from the Categorize page.');
    } catch (err) {
      console.error(err);
      Toast.error(err.message || 'The cash entry could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([['Date (YYYY-MM-DD)', 'Type (Outflow/Inflow)', 'Amount', 'Particulars', 'Vertical', 'Head', 'Sub-head', 'Flow', 'Group']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cash Entries');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    Utils.downloadBlob(new Blob([out], { type: 'application/octet-stream' }), 'Cash Entry Template.xlsx');
  }

  async function onUploadFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    setFileName(file.name);
    setUploadResult(null);
    setUploadBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array', cellDates: false });
      const parsed = parseCashWorkbook(workbook, (date) => Auth.canEditTransactionDate(user, date, settings));
      setMissing(parsed.missing);
      setParseReport({ issues: parsed.issues, blankRows: parsed.blankRows });
      setParsedRows(parsed.missing.length ? null : parsed.rows);
    } catch (err) {
      console.error(err);
      Toast.error('Could not read that file. Please upload a valid .xlsx cash-entry file.');
      setParsedRows(null);
      setMissing([]);
      setParseReport({ issues: [], blankRows: 0 });
    } finally {
      setUploadBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function commitImport() {
    if (!parsedRows || parsedRows.length === 0) {
      Toast.error('There are no valid rows to import.');
      return;
    }
    setUploadBusy(true);
    try {
      const occurrenceByRow = new Map();
      const groupKeyByRow = new Map();
      const toInsert = [];
      const importBatchId = Utils.genId('cashbatch');
      const importedAt = new Date().toISOString();
      for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex++) {
        const record = parsedRows[rowIndex];
        const canonical = canonicalCashRow(record);
        const occurrence = (occurrenceByRow.get(canonical) || 0) + 1;
        occurrenceByRow.set(canonical, occurrence);
        const importHash = await cashImportHash(canonical, occurrence);
        let importGroupKey = groupKeyByRow.get(canonical);
        if (!importGroupKey) {
          importGroupKey = await Utils.importGroupKey('cash-v4', canonical);
          groupKeyByRow.set(canonical, importGroupKey);
        }
        const classification = MasterHelpers.matchImportedClassification(masterData, record);
        toInsert.push({
          id: Utils.genId('txn'), date: record.date, source: TXN_SOURCE.CASH, bankAccountId: '',
          type: classification.matched ? classification.type : record.type,
          verticalId: classification.matched ? classification.selection.verticalId : '',
          headId: classification.matched ? classification.selection.headId : '',
          subHeadId: classification.matched ? classification.selection.subHeadId : '',
          categorySnapshot: classification.matched ? classification.snapshot : undefined,
          withdrawal: record.withdrawal, deposit: record.deposit,
          particulars: record.particulars, particulars2: '', remarksBank: '',
          status: classification.matched ? TXN_STATUS.CATEGORIZED : TXN_STATUS.UNCATEGORIZED,
          importHash, importGroupKey, importOccurrence: occurrence, importHashVersion: 4,
          importBatchId, cashRowOrder: rowIndex + 1, importedAt,
          createdBy: user.id, createdAt: importedAt, updatedAt: importedAt,
        });
      }
      const imported = await DataStore.importTransactions(toInsert, { allowDuplicates: allowUploadDuplicates });
      const storedIds = new Set(imported.transactions.map((item) => item.id));
      const insertedRows = toInsert.filter((item) => storedIds.has(item.id));
      setUploadResult({
        created: imported.inserted, skipped: imported.duplicates,
        categorized: insertedRows.filter((item) => item.status === TXN_STATUS.CATEGORIZED).length,
        pending: insertedRows.filter((item) => item.status === TXN_STATUS.UNCATEGORIZED).length,
        acceptedDuplicates: imported.acceptedDuplicates, rejected: parseReport.issues.length,
      });
      setParsedRows(null);
      setFileName('');
      setAllowUploadDuplicates(false);
      Toast.success(`Imported ${imported.inserted} cash entr${imported.inserted === 1 ? 'y' : 'ies'}; ${insertedRows.filter((item) => item.status === TXN_STATUS.CATEGORIZED).length} categorized, ${insertedRows.filter((item) => item.status === TXN_STATUS.UNCATEGORIZED).length} pending${imported.acceptedDuplicates ? `; ${imported.acceptedDuplicates} reviewed duplicate(s) accepted` : ''}${imported.duplicates ? `; ${imported.duplicates} duplicate(s) skipped` : ''}.`);
    } catch (err) {
      console.error(err);
      Toast.error(err.message || 'The cash entries could not be imported. No rows were saved.');
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <Tabs items={[{ value: 'add', label: '+ Add Entry' }, { value: 'upload', label: '⬆️ Upload File' }]} value={mode} onChange={setMode} />
      </div>

      {mode === 'add' ? (
        <SectionCard>
          <form onSubmit={submit}>
            <div className="field-row">
              <div className="field">
                <label htmlFor="cash-entry-date">Date</label>
                <input id="cash-entry-date" className="input" type="date" required value={form.date} onChange={(e) => set('date', e.target.value)} max={Utils.todayISO()} />
              </div>
              <div className="field">
                <label>Type</label>
                <Tabs items={[{ value: TXN_TYPE.OUTFLOW, label: 'Outflow' }, { value: TXN_TYPE.INFLOW, label: 'Inflow' }]} value={form.type} onChange={(value) => set('type', value)} />
              </div>
              <div className="field">
                <label htmlFor="cash-entry-amount">Amount (₹)</label>
                <input id="cash-entry-amount" className="input" type="number" required min="0.01" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} placeholder="0.00" />
              </div>
            </div>
            <div className="field">
              <label htmlFor="cash-entry-particulars">Particulars</label>
              <input id="cash-entry-particulars" className="input" value={form.particulars} onChange={(e) => set('particulars', e.target.value)} placeholder="Optional note" />
            </div>
            <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? <span className="spinner on-dark"></span> : 'Save Cash Entry'}</button>
          </form>
        </SectionCard>
      ) : (
        <React.Fragment>
          <SectionCard>
            <div className="toolbar" style={{ marginBottom: 0 }}>
              <label className={Utils.classNames('btn btn-primary', uploadBusy && 'disabled')} style={{ cursor: uploadBusy ? 'not-allowed' : 'pointer' }} tabIndex={uploadBusy ? -1 : 0}
                onKeyDown={(e) => { if (!uploadBusy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current && fileRef.current.click(); } }}>
                📄 Choose File
                <input ref={fileRef} className="visually-hidden" tabIndex="-1" type="file" accept=".xlsx,.xls" onChange={onUploadFile} disabled={uploadBusy} />
              </label>
              <button type="button" className="btn btn-secondary" onClick={downloadTemplate} disabled={uploadBusy}>⬇️ Download Template</button>
              {fileName && <span className="chip">{fileName}</span>}
              {uploadBusy && <span className="spinner"></span>}
            </div>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, maxWidth: 720 }}>
              <input type="checkbox" checked={allowUploadDuplicates} onChange={(e) => setAllowUploadDuplicates(e.target.checked)} disabled={uploadBusy} style={{ marginTop: 3 }} />
              <span>Import exact duplicate rows too
                <span className="help-text" style={{ display: 'block' }}>Use only after reviewing the file. Accepted copies are marked separately for audit.</span>
              </span>
            </label>
            {missing.length > 0 && <div className="error-text" role="alert">This file has header issue(s): {missing.join(', ')}. Please match the standard template.</div>}
            {parseReport.issues.length > 0 && (
              <div style={{ marginTop: 14 }} role="status" aria-live="polite">
                <Badge tone="warning">{parseReport.issues.length} invalid row(s) skipped</Badge>
                <div className="help-text" style={{ marginTop: 8 }}>
                  {parseReport.issues.slice(0, 8).map((issue) => <div key={issue.row}>Row {issue.row}: {issue.message}</div>)}
                  {parseReport.issues.length > 8 && <div>…and {parseReport.issues.length - 8} more invalid row(s).</div>}
                </div>
              </div>
            )}
            {uploadResult && (
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 14 }} role="status" aria-live="polite">
                <Badge tone="success">{uploadResult.created} imported</Badge>
                {uploadResult.categorized > 0 && <Badge tone="success">{uploadResult.categorized} auto-categorized</Badge>}
                {uploadResult.pending > 0 && <Badge tone="warning">{uploadResult.pending} pending</Badge>}
                {uploadResult.acceptedDuplicates > 0 && <Badge tone="info">{uploadResult.acceptedDuplicates} reviewed duplicate(s) accepted</Badge>}
                {uploadResult.skipped > 0 && <Badge tone="neutral">{uploadResult.skipped} duplicates skipped</Badge>}
                {uploadResult.rejected > 0 && <Badge tone="warning">{uploadResult.rejected} invalid rows skipped</Badge>}
                {uploadResult.pending > 0 && <a className="btn btn-sm btn-secondary" href="#/categorize">Go to Categorize →</a>}
              </div>
            )}
          </SectionCard>

          {parsedRows && parsedRows.length > 0 && (
            <SectionCard title={`Preview — ${parsedRows.length} row(s) found`}
              actions={<button className="btn btn-accent" onClick={commitImport} disabled={uploadBusy}>{uploadBusy ? <span className="spinner on-dark"></span> : `Import ${parsedRows.length} row(s)`}</button>}>
              <div className="table-wrap" style={{ maxHeight: 420, overflowY: 'auto' }}>
                <table className="dtable">
                  <thead><tr><th>Date</th><th>Particulars</th><th className="cell-num">Withdrawal</th><th className="cell-num">Deposit</th><th>Master classification</th><th>Status after import</th></tr></thead>
                  <tbody>{parsedRows.slice(0, 200).map((record, index) => {
                    const classification = MasterHelpers.matchImportedClassification(masterData, record);
                    return <tr key={index}>
                      <td>{Utils.formatDate(record.date)}</td><td>{record.particulars}</td>
                      <td className="cell-num">{record.withdrawal ? Utils.formatCurrency(record.withdrawal) : ''}</td>
                      <td className="cell-num">{record.deposit ? Utils.formatCurrency(record.deposit) : ''}</td>
                      <td className="cell-muted">{[record.vertical, record.head, record.subHead, record.flow, record.group].filter(Boolean).join(' / ') || '—'}</td>
                      <td>{classification.matched ? <Badge tone="success">Categorized</Badge> : <Badge tone="warning">Pending</Badge>}</td>
                    </tr>;
                  })}</tbody>
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
