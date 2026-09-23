// Large spreadsheet libraries are fetched only for the action that needs them.
const SpreadsheetLibraries = {
  pending: new Map(),
  async load(name) {
    if (window[name]) return window[name];
    if (!this.pending.has(name)) {
      const paths = { XLSX: 'assets/vendor/xlsx-0.20.3.min.js', ExcelJS: 'assets/vendor/exceljs-4.4.0.min.js' };
      const promise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        const timeout = setTimeout(() => fail(), 30000);
        const fail = () => { clearTimeout(timeout); script.remove(); this.pending.delete(name); reject(new Error('Spreadsheet tools could not load. Check your connection and retry.')); };
        script.src = paths[name]; script.async = true; script.onerror = fail;
        script.onload = () => { clearTimeout(timeout); if (window[name]) resolve(window[name]); else fail(); };
        document.head.appendChild(script);
      });
      this.pending.set(name, promise);
    }
    return this.pending.get(name);
  },
};

// ============================================================================
// VIBRANT CashFlow — reusable UI components
// ============================================================================

function BrandLogo({ className, alt = APP_NAME }) {
  return <img className={Utils.classNames('brand-logo', className)} src={BRAND_LOGO_PATH} alt={alt} draggable="false" />;
}

// ---- Toast -------------------------------------------------------------------
// Registered by editing screens. Route changes and browser close use the same
// guard; internal pagination can keep drafts without discarding them.
const UnsavedChanges = {
  checks: new Set(),
  hasChanges() { return [...this.checks].some((check) => check()); },
  confirmLeave() { return !this.hasChanges() || window.confirm('You have unsaved changes. Discard them and leave this page?'); },
};
function useUnsavedChanges(dirty) {
  const dirtyRef = React.useRef(dirty);
  dirtyRef.current = dirty;
  React.useEffect(() => {
    const check = () => dirtyRef.current;
    UnsavedChanges.checks.add(check);
    const warn = (event) => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', warn);
    return () => { UnsavedChanges.checks.delete(check); window.removeEventListener('beforeunload', warn); };
  }, []);
}

const Toast = {
  _sub: null,
  show(message, type) {
    const t = { id: Utils.genId('t'), message, type: type || 'info', icon: type === 'success' ? '✓' : type === 'error' ? '⚠' : 'ℹ' };
    if (Toast._sub) Toast._sub(t);
  },
  success(m) { Toast.show(m, 'success'); },
  error(m) { Toast.show(m, 'error'); },
  info(m) { Toast.show(m, 'info'); },
};

function ToastHost() {
  const [toasts, setToasts] = React.useState([]);
  React.useEffect(() => {
    Toast._sub = (t) => {
      setToasts((list) => [...list, t]);
      setTimeout(() => setToasts((list) => list.filter((x) => x.id !== t.id)), 3400);
    };
    return () => { Toast._sub = null; };
  }, []);
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} role={t.type === 'error' ? 'alert' : 'status'} className={`toast ${t.type} slide-down`}>
          <span>{t.icon}</span><span>{t.message}</span>
        </div>
      ))}
    </div>
  );
}

// ---- Searchable select ---------------------------------------------------------
// The open menu is rendered through a portal straight into <body>, positioned
// by the control's on-screen rect. That's deliberate: a select living inside a
// scrollable table (Categorize, etc.) would otherwise have its menu clipped by
// the table's own overflow, or hidden behind the next row — <tr>/<td> boxes
// have their own quirky stacking rules that a plain z-index can't out-rank.
function SearchableSelect({ options, value, onChange, placeholder, disabled, size, clearable, ariaLabel }) {
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [hi, setHi] = React.useState(0);
  const [visibleCount, setVisibleCount] = React.useState(80);
  const [rect, setRect] = React.useState(null);
  const ref = React.useRef(null);
  const menuRef = React.useRef(null);
  const inputRef = React.useRef(null);
  const menuId = React.useId();

  const updateRect = React.useCallback(() => {
    if (ref.current) setRect(ref.current.getBoundingClientRect());
  }, []);

  React.useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      const insideControl = ref.current && ref.current.contains(e.target);
      const insideMenu = menuRef.current && menuRef.current.contains(e.target);
      if (!insideControl && !insideMenu) setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    updateRect();
    setQuery(''); setHi(0);
    setTimeout(() => inputRef.current && inputRef.current.focus(), 30);
    // Keep the portal aligned to the control if the page (or a scrollable
    // ancestor, e.g. a table) scrolls or the window resizes while it's open.
    window.addEventListener('scroll', updateRect, true);
    window.addEventListener('resize', updateRect);
    return () => {
      window.removeEventListener('scroll', updateRect, true);
      window.removeEventListener('resize', updateRect);
    };
  }, [open, updateRect]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = options || [];
    const tokens = q.split(/\s+/).filter(Boolean);
    return q ? list.filter((o) => tokens.every((token) => (o.searchText || o.label).toLowerCase().includes(token))) : list;
  }, [options, query]);
  React.useEffect(() => { setHi(0); setVisibleCount(80); }, [query, options]);
  React.useEffect(() => {
    if (open) document.getElementById(`${menuId}-option-${hi}`)?.scrollIntoView({ block: 'nearest' });
  }, [hi, open, menuId]);
  React.useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  const selected = (options || []).find((o) => o.value === value);

  function pick(opt) { onChange(opt ? opt.value : ''); setOpen(false); }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi((h) => Math.max(0, Math.min(h + 1, visibleCount - 1, filtered.length - 1))); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((h) => Math.max(h - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); if (filtered[hi]) pick(filtered[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
  }

  function onControlKeyDown(e) {
    if (disabled) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'Escape' && open) {
      e.preventDefault(); e.stopPropagation(); setOpen(false);
    }
  }

  const openAbove = rect && (window.innerHeight - rect.bottom < 290) && rect.top > window.innerHeight - rect.bottom;
  const menuPosition = rect ? {
    position: 'fixed',
    top: openAbove ? 'auto' : rect.bottom + 6,
    bottom: openAbove ? window.innerHeight - rect.top + 6 : 'auto',
    left: Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8)),
    width: Math.min(rect.width, window.innerWidth - 16),
  } : {};

  const menu = open && rect && ReactDOM.createPortal(
    <div id={menuId} ref={menuRef} role="listbox" aria-label={`${ariaLabel || placeholder || 'Select'} options`} className="sselect-menu sselect-menu-portal slide-down"
      style={menuPosition}>
      <div className="sselect-search">
        <input ref={inputRef} role="combobox" aria-label={`Search ${ariaLabel || placeholder || 'options'}`} aria-controls={menuId}
          aria-expanded="true" aria-activedescendant={filtered[hi] ? `${menuId}-option-${hi}` : undefined}
          value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown} placeholder="Search..." />
      </div>
      <div className="sselect-options">
        {filtered.length === 0 && <div className="sselect-empty">No matches</div>}
        {filtered.slice(0, visibleCount).map((o, i) => (
          <button id={`${menuId}-option-${i}`} type="button" role="option" aria-selected={o.value === value} key={o.value} className={Utils.classNames('sselect-option', o.value === value && 'selected', i === hi && 'hi')}
            onMouseEnter={() => setHi(i)} onClick={() => pick(o)}>
            <span>{o.label}</span>
            {o.value === value && <span>✓</span>}
          </button>
        ))}
        {filtered.length > visibleCount && <button type="button" className="sselect-option" onClick={() => setVisibleCount((n) => n + 80)}>Show more ({filtered.length - visibleCount} remaining) · or refine search</button>}
      </div>
    </div>,
    document.body
  );

  return (
    <div className={Utils.classNames('sselect', open && 'open', size === 'sm' && 'sm')} ref={ref}>
      <div className="sselect-control" role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={menuId}
        aria-label={ariaLabel || placeholder || 'Select option'}
        aria-disabled={disabled || undefined} tabIndex={disabled ? -1 : 0} onKeyDown={onControlKeyDown}
        onClick={() => !disabled && setOpen((o) => !o)}>
        {selected ? <span>{selected.label}</span> : <span className="sselect-placeholder">{placeholder || 'Select...'}</span>}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {clearable !== false && selected && !disabled && (
            <button type="button" aria-label="Clear selection" className="sselect-clear" onClick={(e) => { e.stopPropagation(); pick(null); }}>✕</button>
          )}
          <span className="sselect-caret">▾</span>
        </div>
      </div>
      {menu}
    </div>
  );
}

function CategorySearch({ masterData, value, onChange, disabled, size }) {
  const options = React.useMemo(() => MasterHelpers.categoryOptions(masterData), [masterData]);
  return <SearchableSelect options={options} value={value.subHeadId} disabled={disabled} size={size}
    ariaLabel="Search Master categories" placeholder="Search Vertical, Head or Sub-head…"
    onChange={(id) => onChange(options.find((o) => o.value === id)?.selection || { type: value.type, verticalId: '', headId: '', subHeadId: '' })} />;
}

function CategoryPicker({ masterData, value, onChange, disabled }) {
  const [steps, setSteps] = React.useState(false);
  return <div className="category-picker">
    <CategorySearch masterData={masterData} value={value} onChange={onChange} disabled={disabled} />
    <button type="button" className="btn btn-ghost btn-sm category-toggle" aria-expanded={steps} disabled={disabled} onClick={() => setSteps((v) => !v)}>{steps ? 'Hide separate selectors' : 'Choose step by step'}</button>
    {steps && <div className="field-row category-steps">
      <div className="field"><label>Category type</label><Tabs disabled={disabled} items={[{ value: 'outflow', label: 'Outflow' }, { value: 'inflow', label: 'Inflow' }, { value: 'internal', label: 'Internal' }]} value={value.type} onChange={(type) => onChange({ ...value, type, headId: '', subHeadId: '' })} /></div>
      <div className="field"><label>Vertical</label><SearchableSelect disabled={disabled} options={MasterHelpers.verticalOptions(masterData)} value={value.verticalId} placeholder="Vertical" onChange={(verticalId) => onChange({ ...value, verticalId, headId: '', subHeadId: '' })} /></div>
      <div className="field"><label>Head</label><SearchableSelect disabled={disabled || !value.verticalId || !value.type} options={MasterHelpers.headOptions(masterData, value.verticalId, value.type)} value={value.headId} placeholder="Head" onChange={(headId) => onChange({ ...value, headId, subHeadId: '' })} /></div>
      <div className="field"><label>Sub-head</label><SearchableSelect disabled={disabled || !value.headId} options={MasterHelpers.subHeadOptions(masterData, value.headId)} value={value.subHeadId} placeholder="Sub-head" onChange={(subHeadId) => onChange({ ...value, subHeadId })} /></div>
    </div>}
  </div>;
}

function OptionalCategory({ masterData, value, type, onChange, disabled }) {
  return <div className={Utils.classNames('optional-category', value && 'enabled')}>
    <label className="category-opt-in"><input type="checkbox" checked={!!value} disabled={disabled} onChange={(e) => onChange(e.target.checked ? { type, verticalId: '', headId: '', subHeadId: '' } : null)} />Categorize now <span className="cell-muted">Optional</span></label>
    {value ? <CategoryPicker masterData={masterData} value={value} onChange={onChange} disabled={disabled} /> : <p className="help-text">You can categorize this entry later.</p>}
  </div>;
}

// ---- Modal -------------------------------------------------------------------
function Modal({ title, onClose, children, footer, wide }) {
  const boxRef = React.useRef(null);
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const titleId = React.useId();
  React.useEffect(() => {
    const previous = document.activeElement;
    const box = boxRef.current;
    const focusable = box && box.querySelector('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusable) focusable.focus();
    function onKey(e) {
      if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeRef.current(); return; }
      if (e.key !== 'Tab' || !boxRef.current) return;
      const items = Array.from(boxRef.current.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'));
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); if (previous && previous.focus) previous.focus(); };
  }, []);
  // Rendered on <body> so the overlay always covers the whole window, whatever
  // styling the page underneath uses.
  return ReactDOM.createPortal(
    <div className="modal-overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div ref={boxRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className={Utils.classNames('modal-box', 'slide-up', wide && 'wide')}>
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button type="button" aria-label="Close dialog" className="modal-close" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

function ConfirmModal({ title, message, tone, confirmLabel, onConfirm, onCancel }) {
  const [busy, setBusy] = React.useState(false);

  async function confirmOnce() {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={title || 'Please confirm'} onClose={onCancel} footer={
      <React.Fragment>
        <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className={`btn ${tone === 'danger' ? 'btn-danger' : 'btn-primary'}`} onClick={confirmOnce} disabled={busy} aria-busy={busy}>
          {busy ? <span className="spinner on-dark"></span> : (confirmLabel || 'Confirm')}
        </button>
      </React.Fragment>
    }>
      <p style={{ margin: 0, fontSize: 13.5, lineHeight: 1.6 }}>{message}</p>
    </Modal>
  );
}

// ---- Cards / stats ---------------------------------------------------------
function StatCard({ icon, label, value, accent, delta }) {
  return (
    <div className={`stat-tile fade-in accent-${accent || 'primary'}`}>
      <div className="stat-tile-icon">{icon}</div>
      <div className="stat-tile-label">{label}</div>
      <div className="stat-tile-value">{value}</div>
      {delta ? <div className="stat-tile-delta" style={{ color: String(delta).trim().startsWith('-') ? 'var(--danger)' : 'var(--success)' }}>{delta}</div> : null}
    </div>
  );
}

function SectionCard({ title, sub, actions, children }) {
  return (
    <div className="card slide-up" style={{ marginBottom: 20 }}>
      {(title || actions) && (
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: title ? 14 : 0 }}>
          <div>
            {title && <p className="card-title">{title}</p>}
            {sub && <p className="card-sub">{sub}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

function Badge({ tone, children }) {
  return <span className={`badge badge-${tone || 'neutral'}`}>{children}</span>;
}

function Tabs({ items, value, onChange, disabled, ariaLabel }) {
  return (
    <div className="tabs" role="group" aria-label={ariaLabel || 'Options'}>
      {items.map((it) => (
        <button key={it.value} type="button" disabled={disabled}
          aria-pressed={value === it.value}
          className={Utils.classNames('tab-btn', value === it.value && 'active')} onClick={() => onChange(it.value)}>
          {it.label}
        </button>
      ))}
    </div>
  );
}

function PageLoader({ label }) {
  return (
    <div className="empty-state fade-in">
      <div className="spinner" style={{ margin: '0 auto 14px' }}></div>
      <div>{label || 'Loading…'}</div>
    </div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div className="empty-state fade-in">
      <div className="ico">{icon || '📄'}</div>
      <div style={{ fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>{title}</div>
      {sub && <div style={{ fontSize: 12.5 }}>{sub}</div>}
    </div>
  );
}

// Shows when report data was loaded (it may come from the short-lived report
// cache) and lets the user pull the latest figures on demand.
function DataFreshness({ loadedAt, onRefresh, busy }) {
  if (!loadedAt) return null;
  const time = new Date(loadedAt).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit' });
  return (
    <div className="data-freshness">
      <span>Updated {time}</span>
      <button type="button" className="btn btn-ghost btn-sm" onClick={onRefresh} disabled={busy} aria-busy={busy}>{busy ? 'Refreshing…' : '↻ Refresh'}</button>
    </div>
  );
}

// Pagination bar shared by Categorize and Master Data. Buttons appear only when
// there is another page; the whole bar is hidden when there is nothing to show.
function Pager({ summary, canPrev, canNext, onPrev, onNext, nextLabel = 'Next', disabled }) {
  if (!summary && !canPrev && !canNext) return null;
  return (
    <div className="pager">
      {summary && <span className="pager-summary">{summary}</span>}
      {(canPrev || canNext) && <React.Fragment>
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !canPrev} onClick={onPrev}>← Prev</button>
        <button type="button" className="btn btn-secondary btn-sm" disabled={disabled || !canNext} onClick={onNext}>{nextLabel} →</button>
      </React.Fragment>}
    </div>
  );
}

// Variance helper shared by Outflow analysis + export (green/amber/red).
function varianceTone(budget, actual) {
  const b = Number(budget) || 0;
  const a = Number(actual) || 0;
  if (b <= 0) return a > 0 ? 'over' : 'under';
  const pct = a / b;
  if (pct > 1) return 'over';
  if (pct >= 0.9) return 'near';
  return 'under';
}

function NavIcon({ name }) {
  const paths = {
    dashboard: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
    upload: 'M12 16V3m-5 5 5-5 5 5M4 14v6h16v-6',
    cashEntry: 'M3 6h18v13H3ZM3 10h18M15 15h3',
    categorize: 'M3 3h8l10 10-8 8L3 11ZM7 7h.01',
    inflow: 'M3 17 9 11l4 4 8-10m-6 0h6v6',
    outflow: 'm3 7 6 6 4-4 8 10m-6 0h6v-6',
    budget: 'M5 3h14v18H5ZM8 7h8M8 11h3m-3 4h3m3-4h2m-2 4h2',
    export: 'M14 3H5v18h14v-9M10 14 21 3m-7 0h7v7',
    masterData: 'm3 7 9-4 9 4-9 4Zm0 5 9 4 9-4M3 17l9 4 9-4',
    users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M13 3.13a4 4 0 0 1 0 7.75M12 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0',
  };
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
