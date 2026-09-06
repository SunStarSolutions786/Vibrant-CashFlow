// ============================================================================
// VIBRANT CashFlow — authentication & access control
// ============================================================================

const SESSION_KEY = 'vcf_session';

const Auth = {};

Auth.getSession = function () {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    const maxAge = Math.max(1, Number(SESSION_MAX_AGE_HOURS) || 24) * 60 * 60 * 1000;
    const loginAt = Number(session.loginAt);
    const age = Date.now() - loginAt;
    if (!session.userId || !Number.isFinite(loginAt) || age < -60000 || age > maxAge) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  } catch (e) { return null; }
};

Auth.setSession = function (userId) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ userId, loginAt: Date.now() }));
};

Auth.clearSession = function () {
  localStorage.removeItem(SESSION_KEY);
};

Auth.getCurrentUser = async function () {
  if (USE_FIREBASE) {
    const firebaseUser = await (await firebaseBridge()).auth.current();
    if (!firebaseUser) return null;
    const profile = await DataStore.getUser(firebaseUser.uid);
    if (!profile || !profile.active) {
      await (await firebaseBridge()).auth.logout();
      return null;
    }
    return profile;
  }
  const session = Auth.getSession();
  if (!session) return null;
  const users = await DataStore.getUsers();
  const user = users.find((u) => u.id === session.userId && u.active);
  if (!user) Auth.clearSession();
  return user || null;
};

Auth.login = async function (username, password) {
  if (USE_FIREBASE) {
    try {
      const firebaseUser = await (await firebaseBridge()).auth.login(String(username).trim(), password);
      const profile = await DataStore.getUser(firebaseUser.uid);
      if (!profile || !profile.active) {
        await (await firebaseBridge()).auth.logout();
        return { ok: false, error: 'This account has no active VIBRANT CashFlow access.' };
      }
      return { ok: true, user: profile };
    } catch (error) {
      console.error('Firebase sign-in failed', error);
      const code = String(error && error.code || '');
      if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
        return { ok: false, error: 'Invalid email or password.' };
      }
      if (code.includes('too-many-requests')) return { ok: false, error: 'Too many attempts. Please wait and try again.' };
      return { ok: false, error: 'Firebase sign in failed. Check the connection and Firebase setup.' };
    }
  }
  const users = await DataStore.getUsers();
  const user = users.find((u) => String(u.username || '').toLowerCase() === String(username).trim().toLowerCase());
  if (!user || !user.active) return { ok: false, error: 'Invalid username or password.' };
  const hash = await Utils.hashText(password);
  if (hash !== user.passwordHash) return { ok: false, error: 'Invalid username or password.' };
  Auth.setSession(user.id);
  return { ok: true, user };
};

Auth.logout = async function () {
  if (USE_FIREBASE) {
    try { await (await firebaseBridge()).auth.logout(); } catch (error) { console.error('Firebase sign-out failed', error); }
  }
  Auth.clearSession();
};

Auth.createFirebaseUser = async function (email, password) {
  if (!USE_FIREBASE) throw new Error('Firebase user creation is only available in Firebase mode.');
  return (await firebaseBridge()).auth.createUser(String(email).trim(), password);
};

Auth.sendFirebasePasswordReset = async function (email) {
  if (!USE_FIREBASE) throw new Error('Firebase password reset is only available in Firebase mode.');
  return (await firebaseBridge()).auth.sendPasswordReset(String(email).trim());
};

// ---- Access control ---------------------------------------------------------
// Central page → allowed-roles map. Keep this the single source of truth so
// nav rendering and route guarding never drift apart.
const PAGE_ACCESS = {
  dashboard: [ROLES.ADMIN, ROLES.BACKOFFICE, ROLES.VIEWER],
  upload: [ROLES.ADMIN, ROLES.BACKOFFICE],
  cashEntry: [ROLES.ADMIN, ROLES.BACKOFFICE],
  categorize: [ROLES.ADMIN, ROLES.BACKOFFICE],
  inflow: [ROLES.ADMIN, ROLES.BACKOFFICE, ROLES.VIEWER],
  outflow: [ROLES.ADMIN, ROLES.BACKOFFICE, ROLES.VIEWER],
  budget: [ROLES.ADMIN],
  masterData: [ROLES.ADMIN],
  users: [ROLES.ADMIN],
  export: [ROLES.ADMIN, ROLES.BACKOFFICE, ROLES.VIEWER],
};

Auth.canAccess = function (user, page) {
  if (!user) return false;
  if (!Object.prototype.hasOwnProperty.call(PAGE_ACCESS, page)) return false;
  const allowed = PAGE_ACCESS[page];
  return allowed.includes(user.role);
};

Auth.isReadOnly = function (user) {
  return user && user.role === ROLES.VIEWER;
};

// Back Office cannot edit/categorize transactions older than settings.editLockDays.
Auth.canEditTransactionDate = function (user, isoDate, settings) {
  if (!user) return false;
  if (user.role === ROLES.ADMIN) return true;
  if (user.role !== ROLES.BACKOFFICE) return false;
  const configured = settings && settings.editLockDays;
  const parsed = Number(configured);
  const lockDays = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_SETTINGS.editLockDays;
  const age = Utils.daysBetween(isoDate, Utils.todayISO());
  return Number.isFinite(age) && age <= lockDays;
};
