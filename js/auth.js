// ============================================================================
// VIBRANT CashFlow — Firebase Authentication and role-based access.
// ============================================================================

const Auth = {};

function profileProblem(profile) {
  if (!profile) return 'This Firebase account has no VIBRANT CashFlow user profile.';
  if (profile.active !== true) return 'The Firestore user profile must contain Boolean active = true.';
  if (!Object.values(ROLES).includes(profile.role)) return 'The Firestore user profile has an invalid role.';
  if (!String(profile.name || '').trim() || !String(profile.username || '').trim()) {
    return 'The Firestore user profile needs name and username fields.';
  }
  return '';
}

Auth.getCurrentUser = async function () {
  const bridge = await firebaseBridge();
  const firebaseUser = await bridge.auth.current();
  if (!firebaseUser) return null;
  const profile = await DataStore.getUser(firebaseUser.uid);
  if (profileProblem(profile)) {
    await bridge.auth.logout();
    return null;
  }
  return profile;
};

Auth.login = async function (email, password) {
  const bridge = await firebaseBridge();
  try {
    const firebaseUser = await bridge.auth.login(String(email).trim(), password);
    const profile = await DataStore.getUser(firebaseUser.uid);
    const problem = profileProblem(profile);
    if (problem) {
      await bridge.auth.logout();
      return { ok: false, error: problem };
    }
    return { ok: true, user: profile };
  } catch (error) {
    console.error('Firebase sign-in failed', error);
    const code = String(error && error.code || '');
    if (code.includes('invalid-credential') || code.includes('wrong-password') || code.includes('user-not-found')) {
      return { ok: false, error: 'Invalid email or password.' };
    }
    if (code.includes('too-many-requests')) return { ok: false, error: 'Too many attempts. Please wait and try again.' };
    return { ok: false, error: 'Firebase sign in failed. Check the connection and Firebase configuration.' };
  }
};

Auth.logout = async function () {
  try { await (await firebaseBridge()).auth.logout(); }
  catch (error) { console.error('Firebase sign-out failed', error); }
};

Auth.createFirebaseUser = async function (email, password) {
  return (await firebaseBridge()).auth.createUser(String(email).trim(), password);
};

Auth.sendFirebasePasswordReset = async function (email) {
  return (await firebaseBridge()).auth.sendPasswordReset(String(email).trim());
};

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
  return Boolean(user && Object.prototype.hasOwnProperty.call(PAGE_ACCESS, page)
    && PAGE_ACCESS[page].includes(user.role));
};

Auth.canEditTransactionDate = function (user, isoDate, settings) {
  if (!user) return false;
  if (user.role === ROLES.ADMIN) return true;
  if (user.role !== ROLES.BACKOFFICE) return false;
  const parsed = Number(settings && settings.editLockDays);
  const lockDays = Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : DEFAULT_SETTINGS.editLockDays;
  const age = Utils.daysBetween(isoDate, Utils.todayISO());
  return Number.isFinite(age) && age <= lockDays;
};
