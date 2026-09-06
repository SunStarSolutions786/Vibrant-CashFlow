// ============================================================================
// VIBRANT CashFlow — App configuration
// ============================================================================

const APP_NAME = 'VIBRANT CashFlow';
const APP_TAGLINE = 'Group Cash Flow Management';
const BRAND_LOGO_PATH = 'assets/vibrant-logo.png';

// ----------------------------------------------------------------------------
// Production cut-over: every browser host uses Firebase. Demo/local data is
// not loaded by the shipped application.
// ----------------------------------------------------------------------------
const IS_BROWSER = typeof window !== 'undefined' && typeof location !== 'undefined';
const USE_FIREBASE = IS_BROWSER;

const SESSION_MAX_AGE_HOURS = 24;
const FIREBASE_QUERY_PAGE_SIZE = 250;
const FIREBASE_EXPORT_PAGE_SIZE = 500;
const FIREBASE_EXPORT_MAX_ROWS = 100000;

const FIREBASE_CONFIG = {
  apiKey: 'AIzaSyD3TKgKVwquFwAB0c6J1HO8pPsJLWjoGw4',
  authDomain: 'vibrant-cashflow.firebaseapp.com',
  projectId: 'vibrant-cashflow',
  storageBucket: 'vibrant-cashflow.firebasestorage.app',
  messagingSenderId: '901569887836',
  appId: '1:901569887836:web:361f793e3888a612b57099',
};

if (IS_BROWSER) {
  window.VCF_USE_FIREBASE = USE_FIREBASE;
  window.VCF_FIREBASE_CONFIG = FIREBASE_CONFIG;
  window.VCF_FIREBASE_READY = new Promise((resolve, reject) => {
    window.vcfResolveFirebase = resolve;
    window.vcfRejectFirebase = reject;
  });
  if (!USE_FIREBASE) window.vcfResolveFirebase(null);
}

// Default application settings (seeded once, then editable by Admin).
const DEFAULT_SETTINGS = {
  editLockDays: 7,
  appName: APP_NAME,
};

// Currency / locale formatting.
const LOCALE = 'en-IN';
const CURRENCY = 'INR';

const ROLES = {
  ADMIN: 'admin',
  BACKOFFICE: 'backoffice',
  VIEWER: 'viewer',
};

const ROLE_LABELS = {
  [ROLES.ADMIN]: 'Administrator',
  [ROLES.BACKOFFICE]: 'Back Office',
  [ROLES.VIEWER]: 'Viewer',
};

const TXN_TYPE = {
  INFLOW: 'inflow',
  OUTFLOW: 'outflow',
  INTERNAL: 'internal',
};

const TXN_STATUS = {
  UNCATEGORIZED: 'uncategorized',
  CATEGORIZED: 'categorized',
};

const TXN_SOURCE = {
  BANK: 'bank',
  CASH: 'cash',
};
