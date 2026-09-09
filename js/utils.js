// ============================================================================
// VIBRANT CashFlow — shared utilities
// ============================================================================

const Utils = {};

// ---- IDs -------------------------------------------------------------------
Utils.genId = function (prefix) {
  const rand = Math.random().toString(36).slice(2, 10);
  const time = Date.now().toString(36);
  return (prefix ? prefix + '_' : '') + time + rand;
};

// ---- Dates -------------------------------------------------------------------
// All dates are stored as 'YYYY-MM-DD' strings so they sort correctly as text.
// Constructing dates ourselves (rather than relying on `new Date(string)`) is
// important here: JavaScript otherwise rolls 31-Feb into March without warning.
function strictLocalDate(year, month, day) {
  year = Number(year);
  month = Number(month);
  day = Number(day);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day) ||
      year < 100 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return null;

  // setFullYear avoids JavaScript's special 1900 offset for years 0–99. Midday
  // is used so a daylight-saving boundary cannot move the calendar date.
  const result = new Date(0);
  result.setHours(12, 0, 0, 0);
  result.setFullYear(year, month - 1, day);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day) return null;
  return result;
}

function expandedYear(value) {
  const yearText = String(value);
  // Statement templates historically treated a two-digit year as 20xx. Keep
  // that explicit and deterministic instead of delegating it to the browser.
  return yearText.length === 2 ? 2000 + Number(yearText) : Number(yearText);
}

Utils.toISODate = function (value) {
  const d = value instanceof Date ? value : Utils.parseFlexibleDate(value);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${String(y).padStart(4, '0')}-${m}-${day}`;
};

Utils.isValidISODate = function (value) {
  if (typeof value !== 'string') return false;
  const match = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return !!(match && strictLocalDate(match[1], match[2], match[3]));
};

// Parses the formats used by the app and its spreadsheet templates. Slash
// dates follow en-IN order (DD/MM) when ambiguous; MM/DD is selected only when
// the second component is greater than 12 (for example, 8/14/2026).
Utils.parseFlexibleDate = function (val) {
  if (val == null || val === '') return null;
  if (val instanceof Date) {
    if (Number.isNaN(val.getTime())) return null;
    return strictLocalDate(val.getFullYear(), val.getMonth() + 1, val.getDate());
  }

  if (typeof val === 'number') {
    if (!Number.isFinite(val) || val < 1 || val > 2958465) return null;
    // Excel's conventional epoch is 1899-12-30. Ignore any time-of-day
    // fraction because cash-flow records intentionally store calendar dates.
    const wholeDays = Math.floor(val);
    const utc = new Date(Date.UTC(1899, 11, 30) + wholeDays * 86400000);
    if (Number.isNaN(utc.getTime())) return null;
    return strictLocalDate(utc.getUTCFullYear(), utc.getUTCMonth() + 1, utc.getUTCDate());
  }

  const s = String(val).trim();
  if (!s) return null;

  // ISO date, optionally followed by a normal ISO time suffix.
  let match = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/);
  if (match) return strictLocalDate(match[1], match[2], match[3]);

  // dd-Mon-yy / dd-Mon-yyyy (English month names, short or long).
  match = s.match(/^(\d{1,2})[-\s]([A-Za-z]+)[-\s](\d{2}|\d{4})$/);
  if (match) {
    const monthNames = {
      jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
      apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
      aug: 8, august: 8, sep: 9, sept: 9, september: 9, oct: 10,
      october: 10, nov: 11, november: 11, dec: 12, december: 12,
    };
    const month = monthNames[match[2].toLowerCase()];
    return month ? strictLocalDate(expandedYear(match[3]), month, match[1]) : null;
  }

  // DD/MM is the default. If the second component cannot be a month, the
  // input is necessarily MM/DD. Inputs where neither ordering is valid fail.
  match = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    const year = expandedYear(match[3]);
    if (second > 12 && first <= 12) return strictLocalDate(year, first, second);
    return strictLocalDate(year, second, first);
  }

  return null;
};

Utils.formatDate = function (iso, opts) {
  if (!iso) return '';
  if (!Utils.isValidISODate(String(iso))) return String(iso);
  const [y, m, d] = iso.split('-').map(Number);
  const date = strictLocalDate(y, m, d);
  return date.toLocaleDateString(LOCALE, opts || { day: '2-digit', month: 'short', year: 'numeric' });
};

Utils.monthKey = function (iso) {
  return Utils.isValidISODate(String(iso || '')) ? String(iso).slice(0, 7) : ''; // YYYY-MM
};

Utils.monthLabel = function (monthKey) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey || ''))) return String(monthKey || '');
  const [y, m] = monthKey.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(LOCALE, { month: 'long', year: 'numeric' });
};

Utils.todayISO = function () {
  return Utils.toISODate(new Date());
};

Utils.addMonths = function (monthKey, delta) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(monthKey || '')) || !Number.isInteger(Number(delta))) return '';
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

Utils.daysBetween = function (isoA, isoB) {
  if (!Utils.isValidISODate(String(isoA || '')) || !Utils.isValidISODate(String(isoB || ''))) return NaN;
  const aParts = isoA.split('-').map(Number);
  const bParts = isoB.split('-').map(Number);
  const a = Date.UTC(aParts[0], aParts[1] - 1, aParts[2]);
  const b = Date.UTC(bParts[0], bParts[1] - 1, bParts[2]);
  return Math.round((b - a) / 86400000);
};

// ---- Numbers / currency -------------------------------------------------------
Utils.formatCurrency = function (n, opts) {
  const parsed = Number(n);
  const num = Number.isFinite(parsed) ? parsed : 0;
  return num.toLocaleString(LOCALE, Object.assign({
    style: 'currency', currency: CURRENCY, maximumFractionDigits: 0,
  }, opts || {}));
};

Utils.parseAmount = function (v) {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return v;
  const cleaned = String(v).replace(/[,₹\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = parseFloat(cleaned);
  return isNaN(n) ? 0 : n;
};

// Strict counterpart for imports/forms. Returns null for partial numbers such
// as "100abc", while still accepting Indian comma grouping, ₹ and (100).
Utils.parseAmountStrict = function (v, blankValue) {
  if (v == null || String(v).trim() === '') return blankValue === undefined ? null : blankValue;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let cleaned = String(v).trim().replace(/[₹,\s]/g, '');
  const paren = cleaned.match(/^\((.+)\)$/);
  if (paren) cleaned = '-' + paren[1];
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

// Canonical signed views used throughout calculations. Transaction storage
// keeps the two source columns intact; consumers choose the needed direction.
Utils.netCash = function (t) {
  return (Number(t && t.deposit) || 0) - (Number(t && t.withdrawal) || 0);
};

Utils.netOutflow = function (t) {
  return (Number(t && t.withdrawal) || 0) - (Number(t && t.deposit) || 0);
};

// Mapping-memory keys are bounded so a single unusually long bank narration
// cannot inflate the shared Firestore document indefinitely.
Utils.mappingMemoryKey = function (value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 500);
};

// Stable statement identity. Bank names are editable Master Data labels, so a
// duplicate fingerprint must use the immutable account id instead. Raw source
// text remains part of the fingerprint; categorization never does.
Utils.canonicalStatementRow = function (record, bankAccountId) {
  const rec = record || {};
  const text = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const accountId = String(bankAccountId || rec.bankAccountId || (rec.bankSnapshot && rec.bankSnapshot.id) || '').trim();
  if (!accountId) return '';
  return JSON.stringify([
    'statement-v3', accountId, rec.date, Number(rec.withdrawal), Number(rec.deposit),
    rec.closingBalance == null || rec.closingBalance === '' ? null : Number(rec.closingBalance),
    text(rec.particulars), text(rec.particulars2), text(rec.remarksBank),
  ]);
};

Utils.statementImportHash = async function (canonical, occurrence) {
  if (!canonical) return '';
  return 'statement-v3:' + await Utils.hashText(`${canonical}|occurrence:${occurrence}`);
};

Utils.importGroupKey = async function (prefix, canonical) {
  if (!canonical) return '';
  return `${prefix}:group:` + await Utils.hashText(canonical);
};

Utils.canonicalCashRow = function (record) {
  const rec = record || {};
  const text = (value) => String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  const net = Utils.netCash(rec);
  const isOut = typeof rec.isOut === 'boolean' ? rec.isOut : net < 0;
  const rawAmount = rec.amount == null || rec.amount === '' ? Math.abs(net) : Number(rec.amount);
  const particulars = rec.particulars == null
    ? (String(rec.remarks || '').trim() || 'Cash entry')
    : rec.particulars;
  if (!rec.date || !rec.type || !Number.isFinite(rawAmount) || rawAmount <= 0) return '';
  return JSON.stringify([
    'cash-v4', rec.date, rec.type, isOut ? 'out' : 'in', rawAmount, text(particulars),
  ]);
};

Utils.cashImportHash = async function (canonical, occurrence) {
  if (!canonical) return '';
  return 'cash-v4:' + await Utils.hashText(`${canonical}|occurrence:${occurrence}`);
};

// ---- Misc -------------------------------------------------------------------
Utils.classNames = function (...args) {
  return args.filter(Boolean).join(' ');
};

Utils.groupBy = function (arr, keyFn) {
  const out = {};
  arr.forEach((item) => {
    const k = keyFn(item);
    (out[k] = out[k] || []).push(item);
  });
  return out;
};

Utils.sumBy = function (arr, valFn) {
  return arr.reduce((s, item) => s + (Number(valFn(item)) || 0), 0);
};

Utils.downloadBlob = function (blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

// ---- Simple password hashing (SubtleCrypto SHA-256) ---------------------------
Utils.hashText = async function (text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
};
