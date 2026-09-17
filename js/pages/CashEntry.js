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
  if (rows.length < 2) return { rows: [], missing: ['(sheet is empty)'], issues: [] };

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
  if (missing.length) return { rows: [], missing, issues: [] };

  const parsed = [];
  const issues = [];
  for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex] || [];
    if (row.every((value) => value == null || String(value).trim() === '')) continue;
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
  return { rows: parsed, missing: [], issues };
}

function CashEntryPage({ user, masterData, settings }) {
  const [mode, setMode] = React.useState('add');
  const blank = { date: Utils.todayISO(), type: TXN_TYPE.OUTFLOW, amount: '', particulars: '', category: null, cashVerticalId: '' };
  const [form, setForm] = React.useState(blank);
  const [saving, setSaving] = React.useState(false);
  const [fileName, setFileName] = React.useState('');
  const [parsedRows, setParsedRows] = React.useState(null);
  const [missing, setMissing] = React.useState([]);
  const [parseReport, setParseReport] = React.useState({ issues: [] });
  const [uploadBusy, setUploadBusy] = React.useState(false);
  const [uploadResult, setUploadResult] = React.useState(null);
  const [allowUploadDuplicates, setAllowUploadDuplicates] = React.useState(false);
  const fileRef = React.useRef(null);
  const preparedImport = React.useRef(null);
  const pending = React.useRef(null);
  const [uploadVerticalId, setUploadVerticalId] = React.useState('');
  const [importError, setImportError] = React.useState('');
  useUnsavedChanges(Boolean(parsedRows || form.amount || form.particulars) || saving || uploadBusy);

  function set(field, value) {
    pending.current = null;
    setForm((current) => {
      let category = current.category;
      if (category && field === 'type' && category.type !== 'internal') category = { ...category, type: value, headId: '', subHeadId: '' };
      if (category && field === 'cashVerticalId' && category.verticalId !== value) category = { ...category, verticalId: value, headId: '', subHeadId: '' };
      return { ...current, [field]: value, category };
    });
  }

  function setCategory(category) {
    pending.current = null;
    setForm((f) => ({ ...f, category, type: category && category.type !== 'internal' ? category.type : f.type, cashVerticalId: category?.verticalId || f.cashVerticalId }));
  }

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
    if (saving) return;
    if (!masterData.verticals.some((v) => v.id === form.cashVerticalId)) { Toast.error('Select the cash business / Vertical.'); return; }
    if (form.category) {
      const check = MasterHelpers.validateSelection(masterData, form.category, form.category.type);
      if (!check.valid) { Toast.error(check.error); return; }
    }
    setSaving(true);
    try {
      const now = new Date().toISOString();
      pending.current = pending.current || {
        id: Utils.genId('txn'), _operationId: Utils.genId('entry'), cashVerticalId: form.cashVerticalId, date, source: TXN_SOURCE.CASH, bankAccountId: '',
        type: form.category?.type || form.type, verticalId: form.category?.verticalId || '', headId: form.category?.headId || '', subHeadId: form.category?.subHeadId || '',
        withdrawal: form.type === TXN_TYPE.OUTFLOW ? amount : 0,
        deposit: form.type === TXN_TYPE.INFLOW ? amount : 0,
        particulars: form.particulars.trim() || 'Cash entry', particulars2: '', remarksBank: '',
        status: form.category ? TXN_STATUS.CATEGORIZED : TXN_STATUS.UNCATEGORIZED,
        createdBy: user.id, createdAt: now, updatedAt: now,
      };
      await DataStore.bulkUpsertTransactions([pending.current]);
      pending.current = null;
      setForm({ ...blank, cashVerticalId: form.cashVerticalId });
      Toast.success(form.category ? 'Entry saved and categorized.' : 'Entry saved. Ready to categorize later.');
    } catch (err) {
      console.error(err);
      Toast.error(err.message || 'The cash entry could not be saved. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function downloadTemplate() {
    try { await SpreadsheetLibraries.load('XLSX'); } catch (error) { Toast.error(error.message); return; }
    const ws = XLSX.utils.aoa_to_sheet([['Date (YYYY-MM-DD)', 'Type (Outflow/Inflow)', 'Amount', 'Particulars', 'Vertical', 'Head', 'Sub-head', 'Flow', 'Group']]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Cash Entries');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    Utils.downloadBlob(new Blob([out], { type: 'application/octet-stream' }), 'Cash Entry Template.xlsx');
  }

  async function onUploadFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (parsedRows && !window.confirm('Replace the current preview? Any completed imports remain saved.')) { e.target.value = ''; return; }
    preparedImport.current = null; setImportError('');
    setFileName(file.name);
    setUploadResult(null);
    setUploadBusy(true);
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Choose a spreadsheet smaller than 20 MB. Split large files before importing.');
      await SpreadsheetLibraries.load('XLSX');
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array', cellDates: false });
      const parsed = parseCashWorkbook(workbook, (date) => Auth.canEditTransactionDate(user, date, settings));
      setMissing(parsed.missing);
      setParseReport({ issues: parsed.issues });
      setParsedRows(parsed.missing.length ? null : parsed.rows);
    } catch (err) {
      console.error(err);
      Toast.error('Could not read that file. Please upload a valid .xlsx cash-entry file.');
      setParsedRows(null);
      setMissing([]);
      setParseReport({ issues: [] });
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
      const latestSettings = await DataStore.getSettings();
      if (parsedRows.some((r) => !Auth.canEditTransactionDate(user, r.date, latestSettings))) throw new Error('Some dates are outside your cash-entry edit window. Ask an Administrator.');
      if (!preparedImport.current) {
        const occurrenceByRow = new Map();
        const groupKeyByRow = new Map();
        const toInsert = [];
        const importBatchId = Utils.genId('cashbatch');
        const importedAt = new Date().toISOString();
        for (let rowIndex = 0; rowIndex < parsedRows.length; rowIndex++) {
          const original = parsedRows[rowIndex];
          const named = original.vertical && masterData.verticals.find((v) => normalizedCashText(v.name) === normalizedCashText(original.vertical));
          if (original.vertical && !named) throw new Error('Unknown cash Vertical: ' + original.vertical);
          const cashVerticalId = named ? named.id : uploadVerticalId;
          if (!masterData.verticals.some((v) => v.id === cashVerticalId)) throw new Error('Choose a cash business / Vertical for rows with a blank Vertical column.');
          const record = { ...original, cashVerticalId };
          const canonical = Utils.canonicalCashRow(record);
          const occurrence = (occurrenceByRow.get(canonical) || 0) + 1;
          occurrenceByRow.set(canonical, occurrence);
          const importHash = await Utils.cashImportHash(canonical, occurrence);
          let importGroupKey = groupKeyByRow.get(canonical);
          if (!importGroupKey) {
            importGroupKey = await Utils.importGroupKey('cash-v5', canonical);
            groupKeyByRow.set(canonical, importGroupKey);
          }
          const classification = MasterHelpers.matchImportedClassification(masterData, record);
          toInsert.push({
            id: Utils.genId('txn'), cashVerticalId: record.cashVerticalId, date: record.date, source: TXN_SOURCE.CASH, bankAccountId: '',
            type: classification.matched ? classification.type : record.type,
            verticalId: classification.matched ? classification.selection.verticalId : '',
            headId: classification.matched ? classification.selection.headId : '',
            subHeadId: classification.matched ? classification.selection.subHeadId : '',
            categorySnapshot: classification.matched ? classification.snapshot : undefined,
            withdrawal: record.withdrawal, deposit: record.deposit,
            particulars: record.particulars, particulars2: '', remarksBank: '',
            status: classification.matched ? TXN_STATUS.CATEGORIZED : TXN_STATUS.UNCATEGORIZED,
            importHash, importGroupKey, importOccurrence: occurrence, importHashVersion: 5,
            importBatchId, cashRowOrder: rowIndex + 1, importedAt,
            createdBy: user.id, createdAt: importedAt, updatedAt: importedAt,
          });
        }
        preparedImport.current = toInsert;
      }
      setImportError('');
      const imported = await DataStore.importTransactions(preparedImport.current, { allowDuplicates: allowUploadDuplicates });
      const insertedRows = imported.transactions;
      preparedImport.current = null;
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
      setImportError(err.message || 'Import interrupted. Retry to continue.');
      Toast.error(err.message || 'Import interrupted. Retry to continue.');
    } finally {
      setUploadBusy(false);
    }
  }

  return (
    <div>
      <div className="toolbar">
        <Tabs items={[{ value: 'add', label: '+ Add Entry' }, { value: 'upload', label: '⬆️ Upload File' }]} value={mode} disabled={saving || uploadBusy} onChange={(next) => { if (UnsavedChanges.confirmLeave()) setMode(next); }} />
      </div>

      {mode === 'add' ? (
        <SectionCard>
          <form onSubmit={submit}><fieldset disabled={saving} style={{ border: 0, margin: 0, padding: 0 }}>
            <div className="field"><label>Cash business / Vertical</label><SearchableSelect disabled={saving} options={MasterHelpers.verticalOptions(masterData)} value={form.cashVerticalId} onChange={(v) => set('cashVerticalId', v)} placeholder="Select cash business" /></div>
            <div className="field-row">
              <div className="field">
                <label htmlFor="cash-entry-date">Date</label>
                <input id="cash-entry-date" className="input" type="date" required value={form.date} onChange={(e) => set('date', e.target.value)} max={Utils.todayISO()} />
              </div>
              <div className="field">
                <label>Money direction</label>
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
            <OptionalCategory masterData={masterData} value={form.category} type={form.type} onChange={setCategory} disabled={saving} />
            <button className="btn btn-primary" type="submit" disabled={saving}>{saving ? <span className="spinner on-dark"></span> : 'Save Cash Entry'}</button>
          </fieldset></form>
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
            <div className="field" style={{ marginTop: 14 }}><label>Cash business for rows without a Vertical</label><SearchableSelect disabled={uploadBusy || !!preparedImport.current} options={MasterHelpers.verticalOptions(masterData)} value={uploadVerticalId} onChange={setUploadVerticalId} placeholder="Select cash business" /></div>
            {importError && <p className="error-text" role="alert">{importError} Keep this preview and click Import again to resume.</p>}
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginTop: 14, maxWidth: 720 }}>
              <input type="checkbox" checked={allowUploadDuplicates} onChange={(e) => setAllowUploadDuplicates(e.target.checked)} disabled={uploadBusy || !!preparedImport.current} style={{ marginTop: 3 }} />
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
