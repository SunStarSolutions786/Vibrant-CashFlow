// ============================================================================
// VIBRANT CashFlow — helpers for working with Master Data (Vertical > Head >
// Sub-head) throughout the app: dropdown option builders + id-to-name lookups.
// ============================================================================

const MasterHelpers = {};

MasterHelpers.verticalOptions = function (md) {
  return (md.verticals || []).map((v) => ({ value: v.id, label: v.name }));
};

MasterHelpers.headOptions = function (md, verticalId, appliesTo) {
  const requiredFlow = appliesTo === 'internal' ? 'both' : appliesTo;
  return (md.heads || [])
    .filter((h) => (!verticalId || h.verticalId === verticalId) && (!requiredFlow || h.appliesTo === requiredFlow))
    .map((h) => ({ value: h.id, label: h.name }));
};

MasterHelpers.subHeadOptions = function (md, headId) {
  return (md.subHeads || [])
    .filter((s) => !headId || s.headId === headId)
    .map((s) => ({ value: s.id, label: s.name }));
};

MasterHelpers.bankAccountOptions = function (md) {
  return (md.bankAccounts || []).map((b) => ({ value: b.id, label: b.name }));
};

MasterHelpers.verticalName = function (md, id) {
  const v = (md.verticals || []).find((x) => x.id === id);
  return v ? v.name : '';
};
MasterHelpers.headName = function (md, id) {
  const h = (md.heads || []).find((x) => x.id === id);
  return h ? h.name : '';
};
MasterHelpers.subHeadName = function (md, id) {
  const s = (md.subHeads || []).find((x) => x.id === id);
  return s ? s.name : '';
};
MasterHelpers.bankAccountName = function (md, id) {
  const b = (md.bankAccounts || []).find((x) => x.id === id);
  return b ? b.name : '';
};

// Given a Sub-head id, resolves its parent Head and Vertical too — used a lot
// when rendering flat transaction rows.
MasterHelpers.resolveChain = function (md, subHeadId) {
  const sub = (md.subHeads || []).find((s) => s.id === subHeadId);
  const head = sub ? (md.heads || []).find((h) => h.id === sub.headId) : null;
  const vertical = head ? (md.verticals || []).find((v) => v.id === head.verticalId) : null;
  return {
    subHeadId: sub ? sub.id : '',
    subHeadName: sub ? sub.name : '',
    headId: head ? head.id : '',
    headName: head ? head.name : '',
    verticalId: vertical ? vertical.id : '',
    verticalName: vertical ? vertical.name : '',
    appliesTo: head ? (head.appliesTo || '') : '',
    group: head ? (head.group || '') : '',
  };
};

// A category snapshot is copied onto every categorized transaction and budget.
// Reports read this immutable label/hierarchy instead of the editable master
// rows, so a later rename, move or delete cannot rewrite historical reports.
MasterHelpers.snapshotForSelection = function (md, selection) {
  const pick = selection || {};
  const vertical = (md.verticals || []).find((v) => v.id === pick.verticalId);
  const head = (md.heads || []).find((h) => h.id === pick.headId);
  const sub = (md.subHeads || []).find((s) => s.id === pick.subHeadId);
  if (!vertical || !head || !sub || head.verticalId !== vertical.id || sub.headId !== head.id) return null;
  return {
    verticalId: vertical.id,
    verticalName: vertical.name,
    headId: head.id,
    headName: head.name,
    subHeadId: sub.id,
    subHeadName: sub.name,
    appliesTo: head.appliesTo || '',
    group: head.group || '',
  };
};

MasterHelpers.validateSelection = function (md, selection, type) {
  const pick = selection || {};
  if (!pick.verticalId || !pick.headId || !pick.subHeadId) {
    return { valid: false, ok: false, error: 'Type, Vertical, Head and Sub-head are required.', snapshot: null };
  }
  const snapshot = MasterHelpers.snapshotForSelection(md, pick);
  if (!snapshot) {
    return { valid: false, ok: false, error: 'The selected Vertical / Head / Sub-head hierarchy is no longer valid.', snapshot: null };
  }
  if (type) {
    const requiredFlow = type === 'internal' ? 'both' : type;
    if (!['inflow', 'outflow', 'both'].includes(requiredFlow) || snapshot.appliesTo !== requiredFlow) {
      const label = type === 'internal' ? 'Internal' : type.charAt(0).toUpperCase() + type.slice(1);
      return { valid: false, ok: false, error: `${label} must use a ${requiredFlow} Head.`, snapshot: null };
    }
    if (type === 'internal' && snapshot.group !== 'internal') {
      return { valid: false, ok: false, error: 'Internal must use a Head in the Internal group.', snapshot: null };
    }
  }
  return { valid: true, ok: true, error: '', snapshot };
};

// Optional classification columns in Statement/Cash import files. This is an
// exact hierarchy/metadata match (after harmless trim/case normalization), not
// a fuzzy lookup. A mismatch is intentionally non-fatal: the transaction stays
// uncategorized and can be reviewed on the Categorize page.
MasterHelpers.matchImportedClassification = function (md, values) {
  const source = values || {};
  const norm = (value) => String(value == null ? '' : value).trim().replace(/\s+/g, ' ').toLowerCase();
  const verticalName = norm(source.vertical);
  const headName = norm(source.head);
  const subHeadName = norm(source.subHead);
  const flow = norm(source.flow);
  const group = norm(source.group);
  if (source._classificationHeadersPresent === false || !verticalName || !headName || !subHeadName || !flow) {
    return { matched: false, type: '', selection: null, snapshot: null };
  }

  const vertical = (md.verticals || []).find((item) => norm(item.name) === verticalName);
  const head = vertical && (md.heads || []).find((item) => item.verticalId === vertical.id && norm(item.name) === headName);
  const subHead = head && (md.subHeads || []).find((item) => item.headId === head.id && norm(item.name) === subHeadName);
  if (!vertical || !head || !subHead || norm(head.appliesTo) !== flow || norm(head.group) !== group) {
    return { matched: false, type: '', selection: null, snapshot: null };
  }

  const type = flow === 'both' && group === 'internal' ? TXN_TYPE.INTERNAL : flow;
  const selection = { verticalId: vertical.id, headId: head.id, subHeadId: subHead.id };
  const validation = MasterHelpers.validateSelection(md, selection, type);
  if (!validation.valid) return { matched: false, type: '', selection: null, snapshot: null };
  return { matched: true, type, selection, snapshot: validation.snapshot };
};

MasterHelpers.resolveTransactionChain = function (md, record) {
  const item = record || {};
  const saved = item.categorySnapshot;
  if (saved && (saved.subHeadId || saved.subHeadName) && (saved.headId || saved.headName) && (saved.verticalId || saved.verticalName)) {
    return {
      verticalId: saved.verticalId || '',
      verticalName: saved.verticalName || '',
      headId: saved.headId || '',
      headName: saved.headName || '',
      subHeadId: saved.subHeadId || '',
      subHeadName: saved.subHeadName || '',
      appliesTo: saved.appliesTo || '',
      group: saved.group || '',
    };
  }

  const exact = MasterHelpers.snapshotForSelection(md, item);
  if (exact) return exact;
  const chain = MasterHelpers.resolveChain(md, item.subHeadId);
  return {
    verticalId: chain.verticalId || item.verticalId || '',
    verticalName: chain.verticalName || MasterHelpers.verticalName(md, item.verticalId) || '',
    headId: chain.headId || item.headId || '',
    headName: chain.headName || MasterHelpers.headName(md, item.headId) || '',
    subHeadId: chain.subHeadId || item.subHeadId || '',
    subHeadName: chain.subHeadName || MasterHelpers.subHeadName(md, item.subHeadId) || '',
    appliesTo: chain.appliesTo || '',
    group: chain.group || '',
  };
};

MasterHelpers.snapshotKey = function (snapshotOrChain) {
  const s = snapshotOrChain || {};
  const clean = (value) => String(value || '').trim();
  if (![s.verticalId, s.verticalName, s.headId, s.headName, s.subHeadId, s.subHeadName].some(Boolean)) return '';
  // Include both identity and saved labels. Reusing the same master-data id
  // after a rename must not merge old and new labels in historical reports.
  return JSON.stringify([
    clean(s.verticalId), clean(s.verticalName),
    clean(s.headId), clean(s.headName),
    clean(s.subHeadId), clean(s.subHeadName),
    clean(s.appliesTo).toLowerCase(), clean(s.group).toLowerCase(),
  ]);
};

MasterHelpers.validateMasterData = function (md) {
  const errors = [];
  const data = md || {};
  const fields = ['verticals', 'heads', 'subHeads', 'bankAccounts'];
  fields.forEach((field) => { if (!Array.isArray(data[field])) errors.push(`Master Data ${field} must be a list.`); });
  const verticals = Array.isArray(data.verticals) ? data.verticals : [];
  const heads = Array.isArray(data.heads) ? data.heads : [];
  const subHeads = Array.isArray(data.subHeads) ? data.subHeads : [];
  const banks = Array.isArray(data.bankAccounts) ? data.bankAccounts : [];
  const norm = (value) => String(value || '').trim().toLowerCase();
  const duplicateKeys = (rows, keyOf, label) => {
    const seen = new Set();
    rows.forEach((row) => {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`${label} row is invalid.`); return; }
      const key = keyOf(row);
      if (!key) errors.push(`${label} name is required.`);
      else if (seen.has(key)) errors.push(`Duplicate ${label}: ${row.name}.`);
      else seen.add(key);
    });
  };

  duplicateKeys(verticals, (v) => norm(v.name), 'Vertical');
  duplicateKeys(heads, (h) => `${h.verticalId}|${norm(h.name)}`, 'Head');
  duplicateKeys(subHeads, (s) => `${s.headId}|${norm(s.name)}`, 'Sub-head');
  duplicateKeys(banks, (b) => norm(b.name), 'Bank Account');

  const checkIds = (rows, label) => {
    const seen = new Set();
    rows.forEach((row) => {
      const id = String(row && row.id || '').trim();
      if (!id) errors.push(`${label} id is required.`);
      else if (seen.has(id)) errors.push(`Duplicate ${label} id: ${id}.`);
      else seen.add(id);
    });
  };
  checkIds(verticals, 'Vertical');
  checkIds(heads, 'Head');
  checkIds(subHeads, 'Sub-head');
  checkIds(banks, 'Bank Account');

  const verticalIds = new Set(verticals.filter(Boolean).map((v) => v.id));
  const headIds = new Set(heads.filter(Boolean).map((h) => h.id));
  heads.filter(Boolean).forEach((h) => {
    if (!verticalIds.has(h.verticalId)) errors.push(`Head "${h.name}" has no valid Vertical.`);
    if (!['inflow', 'outflow', 'both'].includes(h.appliesTo)) errors.push(`Head "${h.name}" has an invalid Flow.`);
    if (h.appliesTo === 'outflow' && !['opex', 'capex', 'working capital'].includes(h.group)) errors.push(`Outflow Head "${h.name}" has an invalid Group.`);
    if (h.appliesTo === 'both' && h.group !== 'internal') errors.push(`Both-flow Head "${h.name}" must use the Internal group.`);
    if (h.appliesTo === 'inflow' && h.group) errors.push(`Inflow Head "${h.name}" cannot have an outflow Group.`);
  });
  subHeads.filter(Boolean).forEach((s) => { if (!headIds.has(s.headId)) errors.push(`Sub-head "${s.name}" has no valid Head.`); });
  banks.filter(Boolean).forEach((b) => { if (!verticalIds.has(b.verticalId)) errors.push(`Bank Account "${b.name}" has no valid Vertical.`); });
  return { valid: errors.length === 0, ok: errors.length === 0, errors };
};

// Badge tone for a Head's Capex/Opex/Working Capital "Group" — one place so
// Master Data, Outflow Analysis, Budget & Booking and exports render it consistently.
MasterHelpers.groupTone = function (group) {
  if (group === 'capex') return 'primary';
  if (group === 'working capital') return 'info';
  if (group === 'internal') return 'warning';
  if (group === 'opex') return 'neutral';
  return 'neutral';
};

// Every Head belonging to a given Vertical + type, each carrying its Sub-heads
// — the shape the Budget grid and the Outflow analysis page iterate over.
MasterHelpers.headTree = function (md, appliesTo) {
  return (md.verticals || []).map((v) => ({
    vertical: v,
    heads: (md.heads || [])
      .filter((h) => h.verticalId === v.id && (!appliesTo || h.appliesTo === appliesTo || h.appliesTo === 'both'))
      .map((h) => ({ head: h, subHeads: (md.subHeads || []).filter((s) => s.headId === h.id) })),
  })).filter((g) => g.heads.length > 0);
};
