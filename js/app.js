// ============================================================================
// VIBRANT CashFlow — application shell (nav, routing, session bootstrap)
// ============================================================================

const NAV_ITEMS = [
  { key: 'dashboard', label: 'Dashboard', section: 'Overview' },
  { key: 'upload', label: 'Statement', section: 'Data Entry' },
  { key: 'cashEntry', label: 'Cash Entry', section: 'Data Entry' },
  { key: 'categorize', label: 'Categorize', section: 'Data Entry' },
  { key: 'inflow', label: 'Inflow Analysis', section: 'Analysis' },
  { key: 'outflow', label: 'Outflow Analysis', section: 'Analysis' },
  { key: 'budget', label: 'Budget & Booking', section: 'Analysis' },
  { key: 'export', label: 'Export Reports', section: 'Analysis' },
  { key: 'masterData', label: 'Master Data', section: 'Administration' },
  { key: 'users', label: 'User Management', section: 'Administration' },
];

const PAGE_TITLES = {
  dashboard: ['Dashboard', 'Group cash position at a glance'],
  upload: ['Statement', 'Upload a statement file or add a single entry'],
  cashEntry: ['Cash Entry', 'Record cash entries and choose a category now or later'],
  categorize: ['Categorize Transactions', 'Assign Vertical, Head and Sub-head to each entry'],
  inflow: ['Inflow Analysis', 'Date-wise and Head-wise collection summary'],
  outflow: ['Outflow Analysis', 'Vertical, Head and Sub-head-wise spend vs budget'],
  budget: ['Budget & Booking', 'Plan and track monthly outflow budgets'],
  export: ['Export Reports', 'Download the formatted Inflow / Outflow workbook'],
  masterData: ['Master Data', 'Verticals, Heads, Sub-heads and Bank Accounts'],
  users: ['User Management', 'Back office and admin accounts'],
};

const VALID_ROUTES = new Set(NAV_ITEMS.map((item) => item.key));

function getRoute() {
  const h = (location.hash || '').replace(/^#\/?/, '');
  return VALID_ROUTES.has(h) ? h : 'dashboard';
}

function App() {
  const [booting, setBooting] = React.useState(true);
  const [bootError, setBootError] = React.useState('');
  const [user, setUser] = React.useState(null);
  const [masterData, setMasterData] = React.useState(null);
  const [settings, setSettings] = React.useState(null);
  const [route, setRoute] = React.useState(getRoute());
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const userMenuRef = React.useRef(null);
  const routeRef = React.useRef(route);
  routeRef.current = route;

  React.useEffect(() => {
    function onHashChange() {
      const next = getRoute();
      if (next !== routeRef.current && !UnsavedChanges.confirmLeave()) {
        history.replaceState(null, '', '#/' + routeRef.current); return;
      }
      setRoute(next); setSidebarOpen(false); setMenuOpen(false);
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  React.useEffect(() => {
    function onDocClick(e) { if (userMenuRef.current && !userMenuRef.current.contains(e.target)) setMenuOpen(false); }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const bootstrap = React.useCallback(async () => {
    setBooting(true);
    setBootError('');
    try {
      await window.VCF_FIREBASE_READY;
      const u = await Auth.getCurrentUser();
      setUser(u);
      if (u) {
        const [md, st] = await Promise.all([DataStore.getMasterData(), DataStore.getSettings()]);
        setMasterData(md);
        setSettings(st);
      } else {
        setMasterData({ verticals: [], heads: [], subHeads: [], bankAccounts: [], _revision: 0 });
        setSettings({ ...DEFAULT_SETTINGS });
      }
    } catch (err) {
      console.error('Application bootstrap failed', err);
      setBootError(DataStore.describeError(err, 'The app could not connect to Firebase. Check the connection, configuration and Firestore rules.'));
    } finally {
      setBooting(false);
    }
  }, []);

  React.useEffect(() => { bootstrap(); }, [bootstrap]);

  React.useEffect(() => {
    let alive = true, unsubscribe;
    window.VCF_FIREBASE_READY.then((bridge) => {
      if (!alive) return;
      unsubscribe = bridge.auth.onChange((account) => {
        // Switching accounts in another tab must not retain the old identity.
        if (user && (!account || account.uid !== user.id)) {
          DataStore.clearCache(); setUser(null);
          setMasterData(null); setSettings(null);
          if (account) bootstrap();
        }
      });
    }).catch(() => {});
    return () => { alive = false; if (unsubscribe) unsubscribe(); };
  }, [user && user.id, bootstrap]);

  React.useEffect(() => {
    if (!user) return;
    let alive = true, stop;
    DataStore.watchMetadata(user.id, (key, value) => {
      if (!alive) return;
      if (key.startsWith('user:')) {
        if (!value || !value.active) { DataStore.clearCache(); setUser(null); return; }
        setUser((old) => JSON.stringify(old) === JSON.stringify(value) ? old : value);
      } else if (key === 'masterData') setMasterData((old) => JSON.stringify(old) === JSON.stringify(value) ? old : value);
      else setSettings((old) => JSON.stringify(old) === JSON.stringify(value) ? old : value);
    }, (error) => {
      if (!alive) return;
      if (String(error.code).includes('permission-denied')) { DataStore.clearCache(); setUser(null); }
      else Toast.error(DataStore.describeError(error));
    }).then((unsubscribe) => { if (!alive) unsubscribe(); else stop = unsubscribe; }).catch((error) => { if (alive) Toast.error(DataStore.describeError(error)); });
    return () => { alive = false; if (stop) stop(); };
  }, [user && user.id]);

  const reloadMasterData = React.useCallback(async () => setMasterData(await DataStore.getMasterData()), []);
  const reloadSettings = React.useCallback(async () => setSettings(await DataStore.getSettings()), []);

  async function handleLoggedIn(u) {
    try {
      const [md, st] = await Promise.all([DataStore.getMasterData(), DataStore.getSettings()]);
      setMasterData(md);
      setSettings(st);
      setUser(u);
      location.hash = '#/dashboard';
      setRoute('dashboard');
    } catch (error) {
      console.error('Could not load account data after sign in', error);
      await Auth.logout();
      Toast.error('Signed in, but Firestore access is not configured for this account.');
    }
  }

  async function handleLogout() {
    if (!UnsavedChanges.confirmLeave()) return;
    try {
      await Auth.logout(); setUser(null); setMasterData(null); setSettings(null); setMenuOpen(false);
    } catch (error) { Toast.error('Sign out failed. Check the connection and try again.'); }
  }

  if (booting) {
    return (
      <div className="login-screen">
        <div className="splash">
          <BrandLogo className="splash-logo brand-logo-on-dark" />
          <div className="splash-title">{APP_NAME}</div>
          <div className="splash-bar"><div className="splash-bar-fill"></div></div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div className="login-screen">
        <div className="login-card" role="alert">
          <div className="login-brand"><BrandLogo className="boot-error-logo" /><h1>Unable to start</h1></div>
          <p className="error-text" style={{ marginBottom: 18 }}>{bootError}</p>
          <button type="button" className="btn btn-primary btn-block" onClick={bootstrap}>Retry</button>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <React.Fragment>
        <ToastHost />
        <LoginPage onLoggedIn={handleLoggedIn} />
      </React.Fragment>
    );
  }

  const activeRoute = Auth.canAccess(user, route) ? route : 'dashboard';
  const sections = ['Overview', 'Data Entry', 'Analysis', 'Administration'];
  const [title, subtitle] = PAGE_TITLES[activeRoute] || ['', ''];
  const initials = (user.name || user.username || '?').split(' ').map((s) => s[0]).slice(0, 2).join('').toUpperCase();

  const commonProps = { user, masterData, settings, reloadMasterData, reloadSettings };

  return (
    <React.Fragment>
      <ToastHost />
      <div className="app-shell">
        {sidebarOpen && <div className="sidebar-backdrop" onClick={() => setSidebarOpen(false)}></div>}
        <aside className={Utils.classNames('sidebar', sidebarOpen && 'open')}>
          <div className="sidebar-brand">
            <BrandLogo className="sidebar-brand-logo brand-logo-on-dark" />
            <div className="sidebar-brand-text">
              <b>{APP_NAME}</b>
              <span>{APP_TAGLINE}</span>
            </div>
          </div>
          <nav className="sidebar-nav">
            {sections.map((sec) => {
              const items = NAV_ITEMS.filter((it) => it.section === sec && Auth.canAccess(user, it.key));
              if (items.length === 0) return null;
              return (
                <div key={sec}>
                  <div className="sidebar-section-label">{sec}</div>
                  {items.map((it) => (
                    <a key={it.key} href={`#/${it.key}`} className={Utils.classNames('nav-item', activeRoute === it.key && 'active')}>
                      <span className="nav-ico"><NavIcon name={it.key} /></span>
                      <span>{it.label}</span>
                    </a>
                  ))}
                </div>
              );
            })}
          </nav>
          <div className="sidebar-footer">© {new Date().getFullYear()} {APP_NAME}</div>
        </aside>

        <div className="main-area">
          <header className="topbar">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button type="button" className="btn btn-ghost btn-icon mobile-menu-btn" aria-label="Toggle navigation" aria-expanded={sidebarOpen} onClick={() => setSidebarOpen((o) => !o)}>☰</button>
              <BrandLogo className="topbar-brand-logo" alt="" />
              <div>
                <div className="topbar-title">{title}</div>
                <div className="topbar-sub">{subtitle}</div>
              </div>
            </div>
            <div className="topbar-right">
              <span className="chip">{ROLE_LABELS[user.role] || user.role}</span>
              <div style={{ position: 'relative' }} ref={userMenuRef}>
                <button type="button" className="user-chip" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((o) => !o)}>
                  <div className="user-avatar">{initials}</div>
                  <div className="user-meta">
                    <b>{user.name || user.username}</b>
                    <span>@{user.username}</span>
                  </div>
                </button>
                {menuOpen && (
                  <div className="sselect-menu slide-down" role="menu" style={{ right: 0, left: 'auto', width: 180 }}>
                    <div className="sselect-options">
                      <button type="button" role="menuitem" className="sselect-option user-menu-action" onClick={handleLogout}>🚪 Sign out</button>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </header>

          <main className="page-content fade-in" key={activeRoute}>
            <PageRouter route={activeRoute} commonProps={commonProps} />
          </main>
        </div>
      </div>
    </React.Fragment>
  );
}

function PageRouter({ route, commonProps }) {
  switch (route) {
    case 'dashboard': return <DashboardPage {...commonProps} />;
    case 'upload': return <UploadStatementPage {...commonProps} />;
    case 'cashEntry': return <CashEntryPage {...commonProps} />;
    case 'categorize': return <CategorizePage {...commonProps} />;
    case 'inflow': return <InflowAnalysisPage {...commonProps} />;
    case 'outflow': return <OutflowAnalysisPage {...commonProps} />;
    case 'budget': return <BudgetBookingPage {...commonProps} />;
    case 'export': return <ExportReportsPage {...commonProps} />;
    case 'masterData': return <MasterDataPage {...commonProps} />;
    case 'users': return <UsersPage {...commonProps} />;
    default: return <DashboardPage {...commonProps} />;
  }
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(<App />);
