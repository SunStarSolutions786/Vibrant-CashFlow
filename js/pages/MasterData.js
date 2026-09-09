// ============================================================================
// VIBRANT CashFlow — Master Data (Verticals, Heads, Sub-heads, Bank Accounts)
// ============================================================================

function masterImportHeaderKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

const MASTER_CLASSIFICATION_COLUMNS = {
  vertical: 'vertical', head: 'head', subhead: 'subHead',
  flowinflowoutflowboth: 'flow', appliestoinflowoutflowboth: 'flow',
  groupcapexopexworkingcapitalinternal: 'group', groupcapexopex: 'group', group: 'group',
};

function readMasterImportSheet(workbook, names, columns, required, label) {
  const matches = names.filter((name) => workbook.Sheets[name]);
  if (matches.length === 0) return { present: false, rows: [], issues: [] };
  if (matches.length > 1) {
    return { present: true, rows: [], issues: [`${label}: use only one of the supported sheet names (${matches.join(', ')}).`] };
  }

  const rawRows = XLSX.utils.sheet_to_json(workbook.Sheets[matches[0]], { header: 1, defval: '', raw: true });
  const headerMap = {};
  const duplicates = [];
  (rawRows[0] || []).forEach((value, index) => {
    const field = columns[masterImportHeaderKey(value)];
    if (!field) return;
    if (headerMap[field] != null) duplicates.push(field);
    else headerMap[field] = index;
  });
  const missing = required.filter((field) => headerMap[field] == null);
  const issues = [];
  if (missing.length) issues.push(`${label}: missing column(s): ${missing.join(', ')}.`);
  if (duplicates.length) issues.push(`${label}: duplicate column(s): ${Array.from(new Set(duplicates)).join(', ')}.`);
  if (issues.length) return { present: true, rows: [], issues };

  const rows = rawRows.slice(1)
    .map((row, index) => ({ row: row || [], rowNumber: index + 2 }))
    .filter(({ row }) => row.some((value) => value != null && String(value).trim() !== ''))
    .map(({ row, rowNumber }) => {
      const parsed = { _rowNumber: rowNumber };
      Object.entries(headerMap).forEach(([field, index]) => {
        parsed[field] = row[index] == null ? '' : row[index];
      });
      return parsed;
    });
  return { present: true, rows, issues: [] };
}

function parseMasterImportWorkbook(workbook) {
  const verticals = readMasterImportSheet(workbook, ['Verticals'], { name: 'name' }, ['name'], 'Verticals');
  const classifications = readMasterImportSheet(workbook, ['Heads & Sub-heads'], MASTER_CLASSIFICATION_COLUMNS,
    ['vertical', 'head', 'subHead', 'flow', 'group'], 'Heads & Sub-heads');
  const legacyHeads = readMasterImportSheet(workbook, ['Heads'], MASTER_CLASSIFICATION_COLUMNS,
    ['vertical', 'head', 'flow'], 'Heads');
  const legacySubHeads = readMasterImportSheet(workbook, ['Sub-heads', 'SubHeads'], MASTER_CLASSIFICATION_COLUMNS,
    ['vertical', 'head', 'subHead'], 'Sub-heads');
  const banks = readMasterImportSheet(workbook, ['Bank Accounts', 'BankAccounts'],
    { bankaccountname: 'bankName', vertical: 'vertical' }, ['bankName', 'vertical'], 'Bank Accounts');
  const sheets = { verticals, classifications, legacyHeads, legacySubHeads, banks };
  return {
    ...sheets,
    recognized: Object.values(sheets).some((item) => item.present),
    issues: Object.values(sheets).flatMap((item) => item.issues),
  };
}

function MasterDataPage({ masterData, reloadMasterData }) {
  const [tab, setTab] = React.useState('banks');
  const [search, setSearch] = React.useState('');
  const [modal, setModal] = React.useState(null); // {kind, item}
  const [confirmDelete, setConfirmDelete] = React.useState(null); // {kind, id, label}
  const [busy, setBusy] = React.useState(false);
  const fileRef = React.useRef(null);
  const md = masterData;
  const q = search.trim().toLowerCase();

  async function persist(next) {
    const validation = MasterHelpers.validateMasterData(next);
    if (!validation.valid) throw new Error(validation.errors.slice(0, 5).join(' '));
    await DataStore.saveMasterData(next);
    try { await DataStore.pruneMappingMemory(next); }
    catch (err) { console.warn('Master Data saved, but stale mapping cleanup failed.', err); }
    await reloadMasterData();
  }

  async function removeItem(kind, id) {
    if (busy) return;
    const next = {
      ...md,
      verticals: md.verticals.filter((v) => kind !== 'vertical' || v.id !== id),
      heads: md.heads.filter((h) => (kind !== 'head' || h.id !== id) && (kind !== 'vertical' || h.verticalId !== id)),
      subHeads: md.subHeads.filter((s) => kind !== 'subhead' || s.id !== id),
      bankAccounts: md.bankAccounts.filter((b) => (kind !== 'bank' || b.id !== id) && (kind !== 'vertical' || b.verticalId !== id)),
    };
    if (kind === 'head') next.subHeads = next.subHeads.filter((s) => s.headId !== id);
    if (kind === 'vertical') {
      const deadHeadIds = new Set(md.heads.filter((h) => h.verticalId === id).map((h) => h.id));
      next.subHeads = next.subHeads.filter((s) => !deadHeadIds.has(s.headId));
    }
    setBusy(true);
    try {
      await persist(next);
      setConfirmDelete(null);
      Toast.success('Removed. Historical saved records were kept unchanged.');
    } catch (err) {
      console.error(err); Toast.error(err.message || 'Could not remove that item.');
    } finally { setBusy(false); }
  }

  async function commitEdit(next) {
    if (busy) return;
    setBusy(true);
    try {
      await persist(next);
      setModal(null);
      Toast.success('Saved. Historical saved records were kept unchanged.');
    } catch (err) {
      console.error(err); Toast.error(err.message || 'Could not save Master Data.');
    } finally { setBusy(false); }
  }

  async function saveVertical(name, existing) {
    const next = { ...md, verticals: md.verticals.slice() };
    if (existing) next.verticals = next.verticals.map((v) => (v.id === existing.id ? { ...v, name } : v));
    else next.verticals.push({ id: Utils.genId('vert'), name });
    await commitEdit(next);
  }
  async function saveHead(form, existing) {
    const next = { ...md, heads: md.heads.slice() };
    if (existing) next.heads = next.heads.map((h) => (h.id === existing.id ? { ...h, ...form } : h));
    else next.heads.push({ id: Utils.genId('head'), ...form });
    await commitEdit(next);
  }
  async function saveSubHead(form, existing) {
    const next = { ...md, subHeads: md.subHeads.slice() };
    if (existing) next.subHeads = next.subHeads.map((s) => (s.id === existing.id ? { ...s, ...form } : s));
    else next.subHeads.push({ id: Utils.genId('sub'), ...form });
    await commitEdit(next);
  }
  async function saveBank(form, existing) {
    const next = { ...md, bankAccounts: md.bankAccounts.slice() };
    if (existing) next.bankAccounts = next.bankAccounts.map((b) => (b.id === existing.id ? { ...b, ...form } : b));
    else next.bankAccounts.push({ id: Utils.genId('bank'), ...form });
    await commitEdit(next);
  }

  function downloadTemplate() {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Bank Account Name', 'Vertical'],
      ...md.bankAccounts.map((b) => [b.name, MasterHelpers.verticalName(md, b.verticalId)])]), 'Bank Accounts');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Name'], ...md.verticals.map((v) => [v.name])]), 'Verticals');

    // One sheet, one row per Sub-head — mirrors the "Heads & Sub-heads" table
    // on screen so Vertical/Head/Flow/Group are never separated from their children.
    const classifyRows = [['Vertical', 'Head', 'Sub-head', 'Flow (inflow/outflow/both)', 'Group (Capex/Opex/Working Capital/Internal)']];
    md.heads.slice()
      .sort((a, b) => (MasterHelpers.verticalName(md, a.verticalId) + a.name).localeCompare(MasterHelpers.verticalName(md, b.verticalId) + b.name))
      .forEach((h) => {
        const vName = MasterHelpers.verticalName(md, h.verticalId);
        const subs = md.subHeads.filter((s) => s.headId === h.id);
        if (subs.length === 0) classifyRows.push([vName, h.name, '', h.appliesTo, h.group || '']);
        else subs.forEach((s) => classifyRows.push([vName, h.name, s.name, h.appliesTo, h.group || '']));
      });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(classifyRows), 'Heads & Sub-heads');

    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    Utils.downloadBlob(new Blob([out], { type: 'application/octet-stream' }), 'Master Data Template.xlsx');
  }

  async function onImportFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    if (busy) return;
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const next = { ...md, verticals: md.verticals.slice(), heads: md.heads.slice(), subHeads: md.subHeads.slice(), bankAccounts: md.bankAccounts.slice() };
      let added = 0;
      const issues = [];

      const importedSheets = parseMasterImportWorkbook(wb);
      if (!importedSheets.recognized) {
        throw new Error('Import cancelled. No supported Master Data sheet was found. Download and use the template.');
      }
      if (importedSheets.issues.length) {
        throw new Error(`Import cancelled. ${importedSheets.issues.slice(0, 5).join(' ')}`);
      }

      const findVertical = (name) => next.verticals.find((v) => v.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
      const findHead = (verticalId, name) => next.heads.find((h) => h.verticalId === verticalId && h.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
      const findSub = (headId, name) => next.subHeads.find((s) => s.headId === headId && s.name.trim().toLowerCase() === String(name || '').trim().toLowerCase());
      const flowOf = (r) => String(r.flow || '').trim().toLowerCase();
      const groupOf = (r) => String(r.group || '').trim().toLowerCase();

      importedSheets.verticals.rows.forEach((r) => { const name = String(r.name || '').trim(); if (name && !findVertical(name)) { next.verticals.push({ id: Utils.genId('vert'), name }); added++; } });

      const addClassification = (r) => {
        const rowNumber = r._rowNumber;
        const verticalName = String(r.vertical || '').trim();
        const v = findVertical(verticalName); const headName = String(r.head || '').trim();
        const flow = flowOf(r); let group = groupOf(r);
        if (!verticalName && !headName && !String(r.subHead || '').trim()) return;
        if (!v || !headName) { issues.push(`Classification row ${rowNumber}: valid Vertical and Head are required.`); return; }
        if (!['inflow', 'outflow', 'both'].includes(flow)) { issues.push(`Classification row ${rowNumber}: Flow must be inflow, outflow or both.`); return; }
        if (flow === 'inflow') group = '';
        else if (flow === 'both') group = 'internal';
        else if (!['opex', 'capex', 'working capital'].includes(group)) { issues.push(`Classification row ${rowNumber}: Outflow Group must be Opex, Capex or Working Capital.`); return; }
        let h = findHead(v.id, headName);
        if (h && (h.appliesTo !== flow || (h.group || '') !== group)) {
          issues.push(`Classification row ${rowNumber}: "${headName}" conflicts with its existing Flow/Group.`); return;
        }
        if (!h) { h = { id: Utils.genId('head'), verticalId: v.id, name: headName, appliesTo: flow, group }; next.heads.push(h); added++; }
        const subName = String(r.subHead || '').trim();
        if (subName && !findSub(h.id, subName)) { next.subHeads.push({ id: Utils.genId('sub'), headId: h.id, name: subName }); added++; }
      };

      const classifyRows = importedSheets.classifications.rows;
      if (classifyRows.length > 0) {
        classifyRows.forEach(addClassification);
      } else {
        // Backward compatible with an older template's separate Heads / Sub-heads sheets.
        importedSheets.legacyHeads.rows.forEach(addClassification);
        importedSheets.legacySubHeads.rows.forEach((r) => {
          const v = findVertical(r.vertical);
          const h = v && findHead(v.id, r.head); const name = String(r.subHead || '').trim();
          if (!v || !h || !name) { issues.push(`Sub-head row ${r._rowNumber}: valid Vertical, Head and Sub-head are required.`); return; }
          if (!findSub(h.id, name)) { next.subHeads.push({ id: Utils.genId('sub'), headId: h.id, name }); added++; }
        });
      }

      importedSheets.banks.rows.forEach((r) => {
        const name = String(r.bankName || '').trim(); if (!name) return;
        const v = findVertical(r.vertical);
        if (!v) { issues.push(`Bank Account row ${r._rowNumber}: "${name}" needs a valid Vertical.`); return; }
        const existingBank = next.bankAccounts.find((b) => b.name.trim().toLowerCase() === name.toLowerCase());
        if (existingBank && existingBank.verticalId !== v.id) { issues.push(`Bank Account row ${r._rowNumber}: "${name}" conflicts with its existing Vertical.`); return; }
        if (!existingBank) { next.bankAccounts.push({ id: Utils.genId('bank'), name, verticalId: v.id }); added++; }
      });

      const validation = MasterHelpers.validateMasterData(next);
      if (!validation.valid) issues.push(...validation.errors);
      if (issues.length) throw new Error(`Import cancelled. ${issues.slice(0, 5).join(' ')}`);
      await DataStore.saveMasterData(next);
      try { await DataStore.pruneMappingMemory(next); }
      catch (err) { console.warn('Master Data imported, but stale mapping cleanup failed.', err); }
      await reloadMasterData();
      Toast.success(`Import complete — ${added} new item(s) added.`);
    } catch (err) {
      console.error(err); Toast.error(err.message || 'Could not import Master Data.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  const verticalsFiltered = md.verticals.filter((v) => !q || v.name.toLowerCase().includes(q));
  const banksFiltered = md.bankAccounts.filter((b) => !q || (b.name + ' ' + MasterHelpers.verticalName(md, b.verticalId)).toLowerCase().includes(q));

  // Heads & Sub-heads shown together, grouped under their Head, so it's
  // immediately obvious which Vertical/Flow a Sub-head belongs to.
  const classifyGroups = md.heads
    .map((h) => {
      const vertical = MasterHelpers.verticalName(md, h.verticalId);
      const allSubs = md.subHeads.filter((s) => s.headId === h.id);
      const headMatches = !q || (h.name + ' ' + vertical).toLowerCase().includes(q);
      const subs = headMatches ? allSubs : allSubs.filter((s) => s.name.toLowerCase().includes(q));
      return { head: h, vertical, subs, headMatches };
    })
    .filter((g) => !q || g.headMatches || g.subs.length > 0)
    .sort((a, b) => (a.vertical + a.head.name).localeCompare(b.vertical + b.head.name));

  return (
    <div>
      <SectionCard>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <button type="button" className="btn btn-secondary" onClick={downloadTemplate} disabled={busy}>⬇️ Download Template</button>
          <label className={Utils.classNames('btn btn-secondary', busy && 'disabled')} style={{ cursor: busy ? 'not-allowed' : 'pointer' }} tabIndex={busy ? -1 : 0}
            onKeyDown={(e) => { if (!busy && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); fileRef.current && fileRef.current.click(); } }}>
            {busy ? <React.Fragment><span className="spinner"></span> Working…</React.Fragment> : '⬆️ Import'}
            <input ref={fileRef} className="visually-hidden" tabIndex="-1" type="file" accept=".xlsx,.xls" onChange={onImportFile} disabled={busy} />
          </label>
        </div>
      </SectionCard>

      <div className="toolbar">
        <Tabs items={[{ value: 'banks', label: 'Bank Accounts' }, { value: 'verticals', label: 'Verticals' }, { value: 'classify', label: 'Heads & Sub-heads' }]} value={tab} onChange={setTab} />
        <div className="spacer" />
        <input className="input" style={{ maxWidth: 240 }} placeholder="Search..." value={search} onChange={(e) => setSearch(e.target.value)} />
        {tab === 'classify' ? (
          <React.Fragment>
            <button className="btn btn-secondary" onClick={() => setModal({ kind: 'heads' })}>+ Add Head</button>
            <button className="btn btn-primary" onClick={() => setModal({ kind: 'subheads' })}>+ Add Sub-head</button>
          </React.Fragment>
        ) : (
          <button className="btn btn-primary" onClick={() => setModal({ kind: tab })}>+ Add</button>
        )}
      </div>

      {tab === 'verticals' && (
        <div className="table-wrap"><table className="dtable">
          <thead><tr><th>Name</th><th></th></tr></thead>
          <tbody>{verticalsFiltered.map((v) => (
            <tr key={v.id}><td>{v.name}</td><td style={{ textAlign: 'right' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'verticals', item: v })}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete({ kind: 'vertical', id: v.id, label: v.name })}>Delete</button>
            </td></tr>
          ))}</tbody>
        </table></div>
      )}

      {tab === 'banks' && (
        <div className="table-wrap"><table className="dtable">
          <thead><tr><th>Bank / Account</th><th>Vertical</th><th></th></tr></thead>
          <tbody>{banksFiltered.map((b) => (
            <tr key={b.id}><td>{b.name}</td><td className="cell-muted">{MasterHelpers.verticalName(md, b.verticalId)}</td><td style={{ textAlign: 'right' }}>
              <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'banks', item: b })}>Edit</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete({ kind: 'bank', id: b.id, label: b.name })}>Delete</button>
            </td></tr>
          ))}</tbody>
        </table></div>
      )}

      {tab === 'classify' && (
        <div className="table-wrap"><table className="dtable">
          <thead><tr><th>Vertical</th><th>Head</th><th>Sub-head</th><th>Flow</th><th>Group</th><th></th></tr></thead>
          <tbody>
            {classifyGroups.length === 0 && (
              <tr><td colSpan="6"><EmptyState icon="🗂️" title="Nothing found" /></td></tr>
            )}
            {classifyGroups.map((g) => {
              const rows = g.subs.length > 0 ? g.subs : [null];
              return rows.map((s) => (
                <tr key={s ? s.id : g.head.id + '-empty'}>
                  <td className="cell-muted">{g.vertical}</td>
                  <td>{g.head.name}</td>
                  <td>{s ? s.name : <span className="cell-muted" style={{ fontStyle: 'italic' }}>— no sub-heads yet —</span>}</td>
                  <td><Badge tone="info">{g.head.appliesTo}</Badge></td>
                  <td>{g.head.group ? <Badge tone={MasterHelpers.groupTone(g.head.group)}>{g.head.group}</Badge> : <span className="cell-muted">—</span>}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    {s ? (
                      <React.Fragment>
                        <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'subheads', item: s })}>Edit</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete({ kind: 'subhead', id: s.id, label: s.name })}>Delete</button>
                      </React.Fragment>
                    ) : (
                      <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'subheads', presetHeadId: g.head.id })}>+ Sub-head</button>
                    )}
                    <span style={{ display: 'inline-block', width: 1, height: 14, background: 'var(--border-strong)', margin: '0 8px', verticalAlign: 'middle' }}></span>
                    <button className="btn btn-ghost btn-sm" onClick={() => setModal({ kind: 'heads', item: g.head })}>Edit Head</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete({ kind: 'head', id: g.head.id, label: g.head.name })}>Delete Head</button>
                  </td>
                </tr>
              ));
            })}
          </tbody>
        </table></div>
      )}

      {modal && <MasterFormModal kind={modal.kind} item={modal.item} presetHeadId={modal.presetHeadId} md={md}
        saving={busy}
        onClose={() => setModal(null)}
        onSaveVertical={saveVertical} onSaveHead={saveHead} onSaveSubHead={saveSubHead} onSaveBank={saveBank} />}

      {confirmDelete && (
        <ConfirmModal title="Delete item" tone="danger" confirmLabel="Delete"
          message={`Delete "${confirmDelete.label}"? Related child items will also be removed. This does not change already-categorized transactions.`}
          onCancel={() => !busy && setConfirmDelete(null)} onConfirm={() => removeItem(confirmDelete.kind, confirmDelete.id)} />
      )}
    </div>
  );
}

function MasterFormModal({ kind, item, presetHeadId, md, saving, onClose, onSaveVertical, onSaveHead, onSaveSubHead, onSaveBank }) {
  const nameId = React.useId();
  const [name, setName] = React.useState(item ? item.name : '');
  const [verticalId, setVerticalId] = React.useState(item ? item.verticalId : (md.verticals[0] && md.verticals[0].id));
  const [headId, setHeadId] = React.useState(item ? item.headId : (presetHeadId || ''));
  const [appliesTo, setAppliesTo] = React.useState(item ? item.appliesTo : 'outflow');
  const [group, setGroup] = React.useState(item ? (item.group || 'opex') : 'opex');

  const titles = { verticals: 'Vertical', heads: 'Head', subheads: 'Sub-head', banks: 'Bank Account' };

  function submit(e) {
    e.preventDefault();
    if (!name.trim()) { Toast.error('Name is required.'); return; }
    if (kind === 'verticals') onSaveVertical(name.trim(), item);
    else if (kind === 'heads') {
      if (!verticalId) { Toast.error('Select a vertical.'); return; }
      const headGroup = appliesTo === 'outflow' ? group : appliesTo === 'both' ? 'internal' : '';
      onSaveHead({ name: name.trim(), verticalId, appliesTo, group: headGroup }, item);
    }
    else if (kind === 'subheads') { if (!headId) { Toast.error('Select a head.'); return; } onSaveSubHead({ name: name.trim(), headId }, item); }
    else if (kind === 'banks') { if (!verticalId) { Toast.error('Select a vertical.'); return; } onSaveBank({ name: name.trim(), verticalId }, item); }
  }

  return (
    <Modal title={`${item ? 'Edit' : 'Add'} ${titles[kind]}`} onClose={onClose} footer={
      <React.Fragment><button type="button" className="btn btn-secondary" onClick={onClose} disabled={saving}>Cancel</button><button type="button" className="btn btn-primary" onClick={submit} disabled={saving}>{saving ? <span className="spinner on-dark"></span> : 'Save'}</button></React.Fragment>
    }>
      <form onSubmit={submit}>
        {(kind === 'heads' || kind === 'banks') && (
          <div className="field"><label>Vertical</label>
            <SearchableSelect ariaLabel="Vertical" options={MasterHelpers.verticalOptions(md)} value={verticalId} onChange={setVerticalId} placeholder="Select vertical" clearable={false} />
          </div>
        )}
        {kind === 'subheads' && (
          <div className="field"><label>Head</label>
            <SearchableSelect ariaLabel="Head" options={md.heads.map((h) => ({ value: h.id, label: `${MasterHelpers.verticalName(md, h.verticalId)} / ${h.name} (${h.appliesTo})` }))} value={headId} onChange={setHeadId} placeholder="Select head" clearable={false} />
          </div>
        )}
        <div className="field"><label htmlFor={nameId}>Name</label><input id={nameId} className="input" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
        {kind === 'heads' && (
          <div className="field"><label>Flow</label>
            <Tabs ariaLabel="Flow" items={[{ value: 'outflow', label: 'Outflow' }, { value: 'inflow', label: 'Inflow' }, { value: 'both', label: 'Both' }]} value={appliesTo} onChange={setAppliesTo} />
          </div>
        )}
        {kind === 'heads' && appliesTo !== 'inflow' && (
          <div className="field" style={{ marginBottom: 0 }}><label>Group</label>
            {appliesTo === 'outflow' ? (
              <Tabs ariaLabel="Group" items={[{ value: 'opex', label: 'Opex' }, { value: 'capex', label: 'Capex' }, { value: 'working capital', label: 'Working Capital' }]} value={group} onChange={setGroup} />
            ) : (
              <Tabs items={[{ value: 'internal', label: 'Internal' }]} value="internal" onChange={() => {}} />
            )}
          </div>
        )}
      </form>
    </Modal>
  );
}
