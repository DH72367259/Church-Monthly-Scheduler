/* ─── Worship Library — Church Schedule App ─────────────────────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════════════════════════
  PIN AUTHENTICATION
  Users log in with phone number + PIN.
  ══════════════════════════════════════════════════════════════════════════ */

const authUtils = window.authUtils || {};
const DEFAULT_COUNTRY_CODE = (window.authDefaults && window.authDefaults.defaultCountryCode) || '91';

function getBootstrapUsers() {
  if (window.bootstrapUsers && typeof window.bootstrapUsers === 'object') {
    return window.bootstrapUsers;
  }
  var fallback = {};
  var phoneRoles = (window.authorizedPhoneNumbers && typeof window.authorizedPhoneNumbers === 'object')
    ? window.authorizedPhoneNumbers
    : {};
  Object.keys(phoneRoles).forEach(function(phone) {
    fallback[phone] = {
      username: phoneRoles[phone] === 'admin' ? 'Admin' : 'User',
      role: phoneRoles[phone],
      active: true,
      phoneVerified: true
    };
  });
  return fallback;
}

function normalizePhoneNumber(phoneNumber) {
  if (authUtils.normalizePhoneNumber) {
    return authUtils.normalizePhoneNumber(phoneNumber, DEFAULT_COUNTRY_CODE);
  }
  var digits = String(phoneNumber || '').replace(/\D/g, '');
  if (String(phoneNumber || '').trim().charAt(0) === '+') {
    return /^\d{10,15}$/.test(digits) ? ('+' + digits) : null;
  }
  if (digits.length === 10) return '+' + DEFAULT_COUNTRY_CODE + digits;
  if (digits.length >= 11 && digits.length <= 15) return '+' + digits;
  return null;
}

function sanitizeUsername(name, fallback) {
  if (authUtils.sanitizeUsername) {
    return authUtils.sanitizeUsername(name, fallback);
  }
  var safe = String(name || '').trim().replace(/\s+/g, ' ');
  return safe ? safe.slice(0, 32) : (fallback || 'User');
}

function isValidPin(pin) {
  return authUtils.validatePin
    ? authUtils.validatePin(pin)
    : /^\d{6}$/.test(String(pin || '').trim());
}

function countActiveAdmins(users) {
  return authUtils.countActiveAdmins
    ? authUtils.countActiveAdmins(users)
    : (users || []).filter(function(user) {
      return user && user.active !== false && user.role === 'admin';
    }).length;
}

async function hashPin(phoneNumber, pin) {
  if (authUtils.hashPin) {
    return authUtils.hashPin(phoneNumber, pin);
  }
  throw new Error('PIN hashing utility is unavailable.');
}

function safeEqual(left, right) {
  return authUtils.safeEqual ? authUtils.safeEqual(left, right) : String(left || '') === String(right || '');
}

/* ── Login state ───────────────────────────────────────────────────────────── */
let authenticatedPhoneNumber = null;
let currentUserProfile = null;
let pendingPinChangeProfile = null;
let _visibilityUnsub = null;
let _adminUsersUnsub = null;
let _adminUsersCache = [];

/* ── Firestore collections ──────────────────────────────────────────────── */
const FS_USERS_COLLECTION      = 'authorizedUsers';
const FS_VISIBILITY_COLLECTION = 'monthVisibility';
const FS_SCHEDULE_COLLECTION   = 'scheduleSnapshots';
const LOCAL_USERS_KEY          = 'pf_users_local';
const LOCAL_VISIBILITY_KEY     = 'pf_visibility_local';
const LOCAL_SCHEDULE_KEY       = 'pf_schedule_local';
const VIEWER_SESSION_KEY       = 'pf_viewer_session';
const VIEWER_SESSION_TTL_MS    = 2 * 24 * 60 * 60 * 1000;
const SELF_PIN_CHANGE_LIMIT    = 2;

/* ── Admin one-session lock (browser-level) ─────────────────────────────── */
const ADMIN_LOCK_KEY        = 'pf_admin_lock';
const ADMIN_LOCK_TTL_MS     = 90000; /* stale lock expires after 90s */
const ADMIN_HEARTBEAT_MS    = 15000;
const PIN_ATTEMPT_PREFIX    = 'pf_pin_attempts_';
const ADMIN_SESSION_ID_KEY  = 'pf_admin_session_id';
const ADMIN_SESSION_ID      = (function() {
  var sid = sessionStorage.getItem(ADMIN_SESSION_ID_KEY);
  if (sid) return sid;
  sid = 'adm_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  sessionStorage.setItem(ADMIN_SESSION_ID_KEY, sid);
  return sid;
})();
let _adminHeartbeatTimer = null;

/* Session-level access role: null | 'viewer' | 'admin' */
let accessRole = null;  /* Auth required on every app load */

/* ── App state ────────────────────────────────────────────────────────────── */
const state = {
  tab:          'sunday',
  sundayData:   [],
  tuesdayData:  [],
  specialData:  [],
  fastingData:  [],
  sundayIdx:    0,
  tuesdayIdx:   0,
  specialIdx:   0,
  fastingIdx:   0
};

/* ── Bootstrap ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  syncAdminControls();
  loadData();
  registerSW();

  /* Re-fetch data silently whenever the user brings the app to the foreground */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && accessRole) {
      refreshData();
    }
  });

  /* Release lock when this app session is closed or backgrounded away */
  window.addEventListener('beforeunload', releaseAdminLock);
  window.addEventListener('pagehide', releaseAdminLock);
});

function getDb() {
  return window.db || null;
}

function getLocalUsersMap() {
  try {
    var raw = localStorage.getItem(LOCAL_USERS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

function setLocalUsersMap(map) {
  localStorage.setItem(LOCAL_USERS_KEY, JSON.stringify(map || {}));
}

function upsertLocalUser(phone, data) {
  var map = getLocalUsersMap();
  map[phone] = Object.assign({}, map[phone] || {}, data || {}, { phone: phone });
  setLocalUsersMap(map);
}

function getLocalVisibilityMap() {
  try {
    var raw = localStorage.getItem(LOCAL_VISIBILITY_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

function setLocalVisibilityMap(map) {
  localStorage.setItem(LOCAL_VISIBILITY_KEY, JSON.stringify(map || {}));
}

async function persistVisibilityMap(visibilityMap) {
  var merged = Object.assign({}, getLocalVisibilityMap(), visibilityMap || {});
  setLocalVisibilityMap(merged);

  var db = getDb();
  if (!db) return;

  try {
    await Promise.all(Object.keys(visibilityMap || {}).map(function(docId) {
      var entry = Object.assign({}, visibilityMap[docId] || {}, {
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: authenticatedPhoneNumber || null
      });
      return db.collection(FS_VISIBILITY_COLLECTION).doc(docId).set(entry, { merge: true });
    }));
  } catch (err) {
    console.warn('Visibility backup save failed:', err.message);
  }
}

function getLocalScheduleMap() {
  try {
    var raw = localStorage.getItem(LOCAL_SCHEDULE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

function setLocalScheduleMap(map) {
  localStorage.setItem(LOCAL_SCHEDULE_KEY, JSON.stringify(map || {}));
}

function emptyScheduleBuckets() {
  return {
    sunday: {},
    tuesday: {},
    special: {},
    fasting: {}
  };
}

function normalizeScheduleBuckets(store) {
  var buckets = emptyScheduleBuckets();
  Object.keys(store || {}).forEach(function(docId) {
    var entry = store[docId] || {};
    if (!entry.tab || !buckets[entry.tab] || !entry.monthKey) return;
    buckets[entry.tab][entry.monthKey] = Object.assign({}, buckets[entry.tab][entry.monthKey] || {}, entry);
  });
  return buckets;
}

async function loadPersistedScheduleBuckets() {
  var buckets = normalizeScheduleBuckets(getLocalScheduleMap());
  var db = getDb();
  if (!db) return buckets;

  try {
    var snapshot = await db.collection(FS_SCHEDULE_COLLECTION).get();
    snapshot.forEach(function(doc) {
      var entry = doc.data() || {};
      if (!entry.tab || !buckets[entry.tab] || !entry.monthKey) return;
      buckets[entry.tab][entry.monthKey] = Object.assign({}, buckets[entry.tab][entry.monthKey] || {}, entry);
    });
  } catch (err) {
    console.warn('Schedule backup lookup failed:', err.message);
  }

  return buckets;
}

function mergeScheduleArray(tab, baseArr, persistedBuckets) {
  var monthMap = Object.assign({}, (persistedBuckets && persistedBuckets[tab]) || {});

  (baseArr || []).forEach(function(month) {
    if (!month || !month.monthKey) return;
    monthMap[month.monthKey] = Object.assign({}, monthMap[month.monthKey] || {}, month);
  });

  return Object.keys(monthMap).sort().map(function(monthKey) {
    return Object.assign({}, monthMap[monthKey], { monthKey: monthKey });
  });
}

function sanitizeScheduleMonthForStorage(month) {
  var clean = Object.assign({}, month || {});
  delete clean.basePublished;
  return clean;
}

function buildVisibilitySnapshot() {
  var visibility = {};
  [['sunday', state.sundayData], ['tuesday', state.tuesdayData], ['special', state.specialData], ['fasting', state.fastingData]].forEach(function(entry) {
    var tab = entry[0];
    var arr = entry[1] || [];
    arr.forEach(function(month) {
      if (!month || !month.monthKey) return;
      visibility[monthDocId(tab, month.monthKey)] = {
        tab: tab,
        monthKey: month.monthKey,
        published: month.published !== false,
        updatedAt: Date.now(),
        updatedBy: authenticatedPhoneNumber || null
      };
    });
  });
  return visibility;
}

function buildScheduleBackupPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    exportedBy: authenticatedPhoneNumber || null,
    schedule: {
      sunday: state.sundayData.map(sanitizeScheduleMonthForStorage),
      tuesday: state.tuesdayData.map(sanitizeScheduleMonthForStorage),
      special: state.specialData.map(sanitizeScheduleMonthForStorage),
      fasting: state.fastingData.map(sanitizeScheduleMonthForStorage)
    },
    visibility: buildVisibilitySnapshot()
  };
}

function normalizeBackupSchedule(payload) {
  var schedule = (payload && payload.schedule && typeof payload.schedule === 'object') ? payload.schedule : {};
  return {
    sunday: Array.isArray(schedule.sunday) ? schedule.sunday : [],
    tuesday: Array.isArray(schedule.tuesday) ? schedule.tuesday : [],
    special: Array.isArray(schedule.special) ? schedule.special : [],
    fasting: Array.isArray(schedule.fasting) ? schedule.fasting : []
  };
}

function setScheduleBackupStatus(message, isError) {
  var statusEl = id('schedule-backup-status');
  if (!statusEl) return;
  statusEl.textContent = message || '';
  statusEl.style.color = isError ? '#dc2626' : '#065f46';
}

async function persistScheduleSnapshots(scheduleByTab) {
  var localMap = getLocalScheduleMap();
  ['sunday', 'tuesday', 'special', 'fasting'].forEach(function(tab) {
    (scheduleByTab[tab] || []).forEach(function(month) {
      if (!month || !month.monthKey) return;
      var payload = Object.assign({}, sanitizeScheduleMonthForStorage(month), {
        tab: tab,
        monthKey: month.monthKey,
        updatedAt: Date.now(),
        updatedBy: authenticatedPhoneNumber || null
      });
      localMap[monthDocId(tab, month.monthKey)] = payload;
    });
  });
  setLocalScheduleMap(localMap);

  var db = getDb();
  if (!db) return;

  try {
    var writes = [];
    ['sunday', 'tuesday', 'special', 'fasting'].forEach(function(tab) {
      (scheduleByTab[tab] || []).forEach(function(month) {
        if (!month || !month.monthKey) return;
        writes.push(db.collection(FS_SCHEDULE_COLLECTION).doc(monthDocId(tab, month.monthKey)).set(Object.assign({}, sanitizeScheduleMonthForStorage(month), {
          tab: tab,
          monthKey: month.monthKey,
          updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
          updatedBy: authenticatedPhoneNumber || null
        }), { merge: true }));
      });
    });
    await Promise.all(writes);
  } catch (err) {
    console.warn('Schedule backup save failed:', err.message);
  }
}

async function fetchBaseScheduleData() {
  const ts = '?t=' + Date.now();
  const [sr, tr, xr, fr] = await Promise.all([
    fetch('./data/sunday-schedule.json' + ts),
    fetch('./data/tuesday-prayer.json'  + ts),
    fetch('./data/special-days.json'    + ts),
    fetch('./data/fasting-prayer.json'  + ts)
  ]);
  if (!sr.ok) throw new Error('sunday-schedule.json not found');
  if (!tr.ok) throw new Error('tuesday-prayer.json not found');

  return {
    sunday: await sr.json(),
    tuesday: await tr.json(),
    special: xr.ok ? await xr.json() : [],
    fasting: fr.ok ? await fr.json() : []
  };
}

async function resolveScheduleData(baseData) {
  var persistedBuckets = await loadPersistedScheduleBuckets();
  return {
    sunday: mergeScheduleArray('sunday', baseData.sunday, persistedBuckets),
    tuesday: mergeScheduleArray('tuesday', baseData.tuesday, persistedBuckets),
    special: mergeScheduleArray('special', baseData.special, persistedBuckets),
    fasting: mergeScheduleArray('fasting', baseData.fasting, persistedBuckets)
  };
}

function setViewerSession(phoneNumber) {
  localStorage.setItem(VIEWER_SESSION_KEY, JSON.stringify({
    phone: phoneNumber,
    expiresAt: Date.now() + VIEWER_SESSION_TTL_MS
  }));
}

function getViewerSession() {
  try {
    var raw = localStorage.getItem(VIEWER_SESSION_KEY);
    if (!raw) return null;
    var session = JSON.parse(raw);
    if (!session || !session.phone || !session.expiresAt) return null;
    if (session.expiresAt <= Date.now()) {
      localStorage.removeItem(VIEWER_SESSION_KEY);
      return null;
    }
    return session;
  } catch (err) {
    return null;
  }
}

function clearViewerSession() {
  localStorage.removeItem(VIEWER_SESSION_KEY);
}

function isWeakSequencePin(pin) {
  var asc = '01234567890';
  var desc = '9876543210';
  return asc.indexOf(pin) !== -1 || desc.indexOf(pin) !== -1;
}

function validatePinPolicy(phoneNumber, pin) {
  var digits = String(phoneNumber || '').replace(/\D/g, '');
  if (!isValidPin(pin)) {
    return 'PIN must be exactly 6 digits.';
  }
  if (/^(\d)\1{5}$/.test(pin)) {
    return 'PIN cannot be all same digits.';
  }
  if (isWeakSequencePin(pin)) {
    return 'PIN cannot be a simple sequence.';
  }
  if (digits.length >= 6) {
    var first6 = digits.slice(0, 6);
    var last6 = digits.slice(-6);
    if (pin === first6 || pin === last6) {
      return 'PIN cannot be first or last 6 digits of phone number.';
    }
  }
  return '';
}

function collectActiveUsersForPinCheck() {
  var usersByPhone = {};
  Object.keys(getBootstrapUsers()).forEach(function(phone) {
    var u = getBootstrapUsers()[phone] || {};
    if (u.active === false) return;
    usersByPhone[phone] = Object.assign({}, u, { phone: phone });
  });

  Object.keys(getLocalUsersMap()).forEach(function(phone) {
    var u = getLocalUsersMap()[phone] || {};
    if (u.active === false) return;
    usersByPhone[phone] = Object.assign({}, usersByPhone[phone] || {}, u, { phone: phone });
  });

  _adminUsersCache.forEach(function(u) {
    if (!u || u.active === false) return;
    usersByPhone[u.phone] = Object.assign({}, usersByPhone[u.phone] || {}, u, { phone: u.phone });
  });

  return Object.keys(usersByPhone).map(function(phone) { return usersByPhone[phone]; });
}

function isPinDuplicateForAnotherUser(phoneNumber, pin) {
  return collectActiveUsersForPinCheck().some(function(user) {
    if (!user || !user.phone || user.phone === phoneNumber || user.active === false) return false;
    return user.pinPlain === pin;
  });
}

function monthDocId(tab, monthKey) {
  return tab + '__' + monthKey;
}

function getBootstrapUser(phoneNumber) {
  var normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;
  var user = getBootstrapUsers()[normalized];
  if (!user) return null;
  return {
    phone: normalized,
    username: sanitizeUsername(user.username, user.role === 'admin' ? 'Admin' : 'User'),
    role: user.role || 'viewer',
    active: user.active !== false,
    pinPlain: user.pinPlain || null,
    pinHash: user.pinHash || null,
    bootstrap: true
  };
}

async function getUserProfile(phoneNumber) {
  var normalized = normalizePhoneNumber(phoneNumber);
  if (!normalized) return null;

  var bootstrap = getBootstrapUser(normalized);
  var merged = bootstrap ? Object.assign({}, bootstrap) : null;
  var db = getDb();

  if (db) {
    try {
      var doc = await db.collection(FS_USERS_COLLECTION).doc(normalized).get();
      if (doc.exists) {
        merged = Object.assign({}, merged || {}, doc.data() || {}, { phone: normalized });
      }
    } catch (err) {
      console.warn('User profile lookup failed:', err.message);
    }
  }

  var local = getLocalUsersMap()[normalized];
  if (local) {
    merged = Object.assign({}, merged || {}, local, { phone: normalized });
  }

  return merged;
}

async function markPinLogin(profile) {
  var db = getDb();
  if (!profile) return;
  upsertLocalUser(profile.phone, {
    phone: profile.phone,
    username: sanitizeUsername(profile.username, profile.role === 'admin' ? 'Admin' : 'User'),
    role: profile.role,
    active: profile.active !== false,
    pinPlain: profile.pinPlain || null,
    pinHash: profile.pinHash || null,
    lastLoginMethod: 'pin',
    lastLoginAt: Date.now()
  });
  if (!db) return;
  try {
    await db.collection(FS_USERS_COLLECTION).doc(profile.phone).set({
      lastLoginMethod: 'pin',
      lastLoginAt: firebase.firestore.FieldValue.serverTimestamp(),
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn('PIN login metadata update failed:', err.message);
  }
}

function setPinAttemptState(phoneNumber, stateObj) {
  localStorage.setItem(PIN_ATTEMPT_PREFIX + phoneNumber, JSON.stringify(stateObj));
}

function getPinAttemptState(phoneNumber) {
  try {
    return JSON.parse(localStorage.getItem(PIN_ATTEMPT_PREFIX + phoneNumber) || '{"count":0,"blockedUntil":0}');
  } catch (err) {
    return { count: 0, blockedUntil: 0 };
  }
}

function clearPinAttemptState(phoneNumber) {
  localStorage.removeItem(PIN_ATTEMPT_PREFIX + phoneNumber);
}

function recordFailedPinAttempt(phoneNumber) {
  var stateObj = getPinAttemptState(phoneNumber);
  stateObj.count = (stateObj.count || 0) + 1;
  if (stateObj.count >= 5) {
    stateObj.blockedUntil = Date.now() + 30000;
  }
  setPinAttemptState(phoneNumber, stateObj);
  return stateObj;
}

function pinBlockedMessage(phoneNumber) {
  var stateObj = getPinAttemptState(phoneNumber);
  if (stateObj.blockedUntil && stateObj.blockedUntil > Date.now()) {
    var remaining = Math.ceil((stateObj.blockedUntil - Date.now()) / 1000);
    return 'Too many wrong PIN attempts. Try again in ' + remaining + 's.';
  }
  return '';
}

function markBasePublished(arr) {
  arr.forEach(function(m) {
    if (typeof m.basePublished === 'undefined') m.basePublished = (m.published !== false);
    if (typeof m.published === 'undefined') m.published = m.basePublished;
  });
}

function applyVisibilityOverrides(overrides) {
  [['sunday', state.sundayData], ['tuesday', state.tuesdayData], ['special', state.specialData], ['fasting', state.fastingData]].forEach(function(entry) {
    var tab = entry[0];
    var arr = entry[1];
    arr.forEach(function(month) {
      var doc = overrides[monthDocId(tab, month.monthKey)];
      month.published = doc ? (doc.published !== false) : month.basePublished;
    });
  });
}

function stopFirestoreSubscriptions() {
  if (_visibilityUnsub) { _visibilityUnsub(); _visibilityUnsub = null; }
  if (_adminUsersUnsub) { _adminUsersUnsub(); _adminUsersUnsub = null; }
}

function subscribeVisibilityOverrides() {
  var db = getDb();
  if (!db) {
    applyVisibilityOverrides(getLocalVisibilityMap());
    refreshAllTabStates();
    return;
  }
  if (_visibilityUnsub) _visibilityUnsub();
  _visibilityUnsub = db.collection(FS_VISIBILITY_COLLECTION).onSnapshot(function(snapshot) {
    var overrides = {};
    snapshot.forEach(function(doc) {
      overrides[doc.id] = doc.data() || {};
    });
    applyVisibilityOverrides(overrides);
    refreshAllTabStates();
    if (accessRole) render();
  }, function(err) {
    console.warn('Visibility subscription error:', err.message);
    applyVisibilityOverrides(getLocalVisibilityMap());
    refreshAllTabStates();
    if (accessRole) render();
  });
}

async function getRoleForPhone(phoneNumber) {
  var profile = await getUserProfile(phoneNumber);
  if (!profile || profile.active === false) return null;
  return (profile.role === 'viewer' || profile.role === 'admin') ? profile.role : null;
}

function renderAdminUsersList(users) {
  var host = id('admin-users-list');
  if (!host) return;
  if (!users.length) {
    host.innerHTML = '<div class="empty-state"><div class="empty-icon">👥</div><p>No authorized users yet.</p></div>';
    return;
  }

  host.innerHTML = users.map(function(user) {
    var roleClass = user.role === 'admin' ? 'admin-badge' : 'viewer-badge';
    var pinStatus = user.pinPlain ? ('PIN: ' + user.pinPlain) : (user.pinHash ? 'PIN is set' : 'No PIN');
    return '<div class="admin-user-row">'
      + '<div class="admin-user-meta">'
      + '<div class="admin-user-name">' + esc(user.username || 'User') + '</div>'
      + '<div class="admin-user-phone">' + esc(user.phone) + '</div>'
      + '<div><span class="role-badge ' + roleClass + '">' + esc(user.role) + '</span></div>'
      + '<div class="admin-user-status">' + esc(pinStatus) + '</div>'
      + '</div>'
      + '<div class="admin-user-actions">'
      + '<button class="mini-btn" onclick="prefillAuthorizedUser(\'' + esc(user.phone).replace(/&#039;/g, "\\'") + '\',\'' + user.role + '\',\'' + esc(user.username || 'User').replace(/&#039;/g, "\\'") + '\')">Edit</button>'
      + '<button class="mini-btn danger" onclick="removeAuthorizedUser(\'' + esc(user.phone).replace(/&#039;/g, "\\'") + '\')">Remove</button>'
      + '</div>'
      + '</div>';
  }).join('');
}

function subscribeAdminUsers() {
  var db = getDb();
  if (accessRole !== 'admin') return;
  if (!db) {
    var users = [];
    var map = getLocalUsersMap();
    Object.keys(map).forEach(function(phone) {
      var data = map[phone] || {};
      if (data.active === false) return;
      users.push({
        phone: phone,
        role: data.role || 'viewer',
        username: sanitizeUsername(data.username, data.role === 'admin' ? 'Admin' : 'User'),
        pinPlain: data.pinPlain || null,
        pinHash: data.pinHash || null,
        active: data.active !== false
      });
    });
    users.sort(function(a, b) {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.phone.localeCompare(b.phone);
    });
    _adminUsersCache = users;
    renderAdminUsersList(users);
    return;
  }
  if (_adminUsersUnsub) _adminUsersUnsub();
  _adminUsersUnsub = db.collection(FS_USERS_COLLECTION).onSnapshot(function(snapshot) {
    var users = [];
    snapshot.forEach(function(doc) {
      var data = doc.data() || {};
      if (data.active === false) return;
      users.push({
        phone: doc.id,
        role: data.role || 'viewer',
        username: sanitizeUsername(data.username, data.role === 'admin' ? 'Admin' : 'User'),
        pinPlain: data.pinPlain || null,
        pinHash: data.pinHash || null,
        active: data.active !== false
      });
    });
    users.sort(function(a, b) {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.phone.localeCompare(b.phone);
    });
    _adminUsersCache = users;
    renderAdminUsersList(users);
  }, function(err) {
    console.warn('Admin users subscription error:', err.message);
    var users = [];
    var map = getLocalUsersMap();
    Object.keys(map).forEach(function(phone) {
      var data = map[phone] || {};
      if (data.active === false) return;
      users.push({
        phone: phone,
        role: data.role || 'viewer',
        username: sanitizeUsername(data.username, data.role === 'admin' ? 'Admin' : 'User'),
        pinPlain: data.pinPlain || null,
        pinHash: data.pinHash || null,
        active: data.active !== false
      });
    });
    users.sort(function(a, b) {
      if (a.role !== b.role) return a.role === 'admin' ? -1 : 1;
      return a.phone.localeCompare(b.phone);
    });
    _adminUsersCache = users;
    renderAdminUsersList(users);
  });
}

function _readAdminLock() {
  try {
    var raw = localStorage.getItem(ADMIN_LOCK_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function _isAdminLockActive(lock) {
  if (!lock || !lock.ownerId || !lock.lastSeen) return false;
  return (Date.now() - lock.lastSeen) < ADMIN_LOCK_TTL_MS;
}

function _writeAdminLock(lockObj) {
  localStorage.setItem(ADMIN_LOCK_KEY, JSON.stringify(lockObj));
}

function _startAdminHeartbeat() {
  if (_adminHeartbeatTimer) clearInterval(_adminHeartbeatTimer);
  _adminHeartbeatTimer = setInterval(function() {
    if (accessRole !== 'admin') return;
    var lock = _readAdminLock();
    if (!lock || lock.ownerId !== ADMIN_SESSION_ID) return;
    lock.lastSeen = Date.now();
    _writeAdminLock(lock);
  }, ADMIN_HEARTBEAT_MS);
}

function _stopAdminHeartbeat() {
  if (_adminHeartbeatTimer) {
    clearInterval(_adminHeartbeatTimer);
    _adminHeartbeatTimer = null;
  }
}

function tryAcquireAdminLock() {
  var lock = _readAdminLock();
  if (_isAdminLockActive(lock) && lock.ownerId !== ADMIN_SESSION_ID) {
    return false;
  }

  var mine = {
    ownerId:  ADMIN_SESSION_ID,
    lastSeen: Date.now()
  };
  _writeAdminLock(mine);

  /* Verify ownership after write */
  var verify = _readAdminLock();
  if (!verify || verify.ownerId !== ADMIN_SESSION_ID) {
    return false;
  }

  _startAdminHeartbeat();
  return true;
}

function releaseAdminLock() {
  if (accessRole !== 'admin') return;
  var lock = _readAdminLock();
  if (lock && lock.ownerId === ADMIN_SESSION_ID) {
    localStorage.removeItem(ADMIN_LOCK_KEY);
  }
  _stopAdminHeartbeat();
}

window.openAdminUsersModal = function openAdminUsersModal() {
  if (accessRole !== 'admin') return;
  id('admin-users-modal').classList.remove('hidden');
  setAdminUsersTab('add');
  id('admin-user-error').textContent = '';
  setScheduleBackupStatus('', false);
  id('admin-user-name').value = '';
  id('admin-user-phone').value = '';
  id('admin-user-role').value = 'viewer';
  id('admin-user-pin').value = '';
  subscribeAdminUsers();
};

window.setAdminUsersTab = function setAdminUsersTab(tab) {
  ['add', 'list', 'backup'].forEach(function(key) {
    var tabEl = id('admin-tab-' + key);
    var panelEl = id('admin-panel-' + key);
    var active = key === tab;
    if (tabEl) {
      tabEl.classList.toggle('active', active);
      tabEl.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    if (panelEl) {
      panelEl.classList.toggle('hidden', !active);
    }
  });
};

window.closeAdminUsersModal = function closeAdminUsersModal() {
  id('admin-users-modal').classList.add('hidden');
  id('admin-user-error').textContent = '';
  setScheduleBackupStatus('', false);
};

window.exportScheduleBackup = function exportScheduleBackup() {
  if (accessRole !== 'admin') return;
  var payload = buildScheduleBackupPayload();
  var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  var link = document.createElement('a');
  var stamp = new Date().toISOString().replace(/[:.]/g, '-');
  link.href = URL.createObjectURL(blob);
  link.download = 'pf-schedule-backup-' + stamp + '.json';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(function() { URL.revokeObjectURL(link.href); }, 1000);
  setScheduleBackupStatus('Backup downloaded successfully.', false);
};

window.triggerScheduleRestore = function triggerScheduleRestore() {
  if (accessRole !== 'admin') return;
  var fileInput = id('schedule-backup-file');
  if (!fileInput) return;
  fileInput.value = '';
  fileInput.click();
};

window.restoreScheduleBackup = function restoreScheduleBackup(event) {
  if (accessRole !== 'admin') return;
  var file = event && event.target && event.target.files ? event.target.files[0] : null;
  if (!file) return;

  var reader = new FileReader();
  reader.onload = async function(loadEvent) {
    try {
      var payload = JSON.parse(String(loadEvent.target && loadEvent.target.result || '{}'));
      if (!payload || payload.version !== 1) {
        throw new Error('Unsupported backup file format.');
      }

      var schedule = normalizeBackupSchedule(payload);
      var totalMonths = schedule.sunday.length + schedule.tuesday.length + schedule.special.length + schedule.fasting.length;
      if (!totalMonths) {
        throw new Error('Backup file does not contain any schedule data.');
      }

      await persistScheduleSnapshots(schedule);
      await persistVisibilityMap((payload.visibility && typeof payload.visibility === 'object') ? payload.visibility : {});
      await refreshData(true);
      setScheduleBackupStatus('Backup restored successfully. Imported data was merged with current schedule.', false);
    } catch (err) {
      console.warn('Schedule backup restore error:', err.message);
      setScheduleBackupStatus(err.message || 'Could not restore backup file.', true);
    }
  };
  reader.onerror = function() {
    setScheduleBackupStatus('Could not read backup file.', true);
  };
  reader.readAsText(file);
};

window.prefillAuthorizedUser = function prefillAuthorizedUser(phone, role, username) {
  if (accessRole !== 'admin') return;
  setAdminUsersTab('add');
  id('admin-user-name').value = username || '';
  id('admin-user-phone').value = phone;
  id('admin-user-role').value = role || 'viewer';
  id('admin-user-pin').value = '';
  id('admin-user-error').textContent = '';
};

window.saveAuthorizedUser = async function saveAuthorizedUser() {
  if (accessRole !== 'admin') return;
  var db = getDb();
  var username = sanitizeUsername(id('admin-user-name').value, 'User');
  var phone = normalizePhoneNumber(id('admin-user-phone').value.trim());
  var role = id('admin-user-role').value;
  var pin = id('admin-user-pin').value.trim();
  var errEl = id('admin-user-error');
  errEl.textContent = '';

  if (!phone) {
    errEl.textContent = 'Enter a valid phone number.';
    return;
  }
  if (role !== 'viewer' && role !== 'admin') {
    errEl.textContent = 'Role must be viewer or admin.';
    return;
  }
  if (phone === authenticatedPhoneNumber && role !== 'admin') {
    errEl.textContent = 'Your current admin session cannot downgrade itself.';
    return;
  }

  var existing = _adminUsersCache.find(function(user) { return user.phone === phone; }) || await getUserProfile(phone);
  var activeAdmins = countActiveAdmins(_adminUsersCache);
  var isNewAdmin = role === 'admin' && (!existing || existing.role !== 'admin');
  if (isNewAdmin && activeAdmins >= 3) {
    errEl.textContent = 'Only 3 active admins are allowed.';
    return;
  }

  if (!pin && !(existing && (existing.pinHash || existing.pinPlain))) {
    errEl.textContent = 'Set an initial 6 digit PIN for this user.';
    return;
  }
  if (pin) {
    var policyError = validatePinPolicy(phone, pin);
    if (policyError) {
      errEl.textContent = policyError;
      return;
    }
    if (isPinDuplicateForAnotherUser(phone, pin)) {
      errEl.textContent = 'This PIN is already used by another user. Use a unique PIN.';
      return;
    }
  }

  if (pin && !isValidPin(pin)) {
    errEl.textContent = 'PIN must be exactly 6 digits.';
    return;
  }

  var payload = {
    phone: phone,
    username: sanitizeUsername(username, role === 'admin' ? 'Admin' : 'User'),
    role: role,
    active: true,
    updatedAt: db ? firebase.firestore.FieldValue.serverTimestamp() : Date.now(),
    updatedBy: authenticatedPhoneNumber || null
  };

  if (!existing || !existing.createdAt) {
    payload.createdAt = db ? firebase.firestore.FieldValue.serverTimestamp() : Date.now();
    payload.createdBy = authenticatedPhoneNumber || null;
  }
  if (pin) {
    payload.pinPlain = pin;
    payload.pinHash = await hashPin(phone, pin);
    payload.pinVersion = 1;
    payload.pinMustChange = true;
    payload.pinUpdatedAt = db ? firebase.firestore.FieldValue.serverTimestamp() : Date.now();
  }

  try {
    upsertLocalUser(phone, payload);
    if (db) {
      await db.collection(FS_USERS_COLLECTION).doc(phone).set(payload, { merge: true });
    }
    id('admin-user-name').value = '';
    id('admin-user-phone').value = '';
    id('admin-user-role').value = 'viewer';
    id('admin-user-pin').value = '';
    subscribeAdminUsers();
  } catch (err) {
    console.warn('Save user error:', err.message);
    errEl.textContent = 'Could not save user. Check Firestore rules.';
  }
};

window.removeAuthorizedUser = async function removeAuthorizedUser(phone) {
  if (accessRole !== 'admin') return;
  var db = getDb();
  var errEl = id('admin-user-error');
  errEl.textContent = '';
  if (phone === authenticatedPhoneNumber) {
    errEl.textContent = 'You cannot remove your own active admin account from this session.';
    return;
  }

  try {
    upsertLocalUser(phone, {
      phone: phone,
      active: false,
      updatedBy: authenticatedPhoneNumber || null,
      updatedAt: Date.now()
    });
    if (db) {
      await db.collection(FS_USERS_COLLECTION).doc(phone).set({
        phone: phone,
        active: false,
        updatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedBy: authenticatedPhoneNumber || null
      }, { merge: true });
    }
    subscribeAdminUsers();
  } catch (err) {
    console.warn('Remove user error:', err.message);
    errEl.textContent = 'Could not remove user. Check Firestore rules.';
  }
};

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then(reg => {
    /* Check for a new SW version every time the app is opened */
    reg.addEventListener('updatefound', () => {
      const newSW = reg.installing;
      newSW.addEventListener('statechange', () => {
        /* New SW installed and ready — reload so users get fresh content */
        if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
          location.reload();
        }
      });
    });
    /* Force-check for SW update every time the page becomes visible */
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update();
    });
  }).catch(() => {/* silent */});

  /* Also reload if a new SW takes over while the app is already open */
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    location.reload();
  });

  /* Hard reload when SW explicitly signals it has updated */
  navigator.serviceWorker.addEventListener('message', event => {
    if (event.data && event.data.type === 'SW_UPDATED') {
      location.reload(true);
    }
  });
}

/* ── Data loading ─────────────────────────────────────────────────────────── */
async function loadData() {
  const content = id('content');
  try {
    var mergedData = await resolveScheduleData(await fetchBaseScheduleData());
    state.sundayData  = mergedData.sunday;
    state.tuesdayData = mergedData.tuesday;
    state.specialData = mergedData.special;
    state.fastingData = mergedData.fasting;

    markBasePublished(state.sundayData);
    markBasePublished(state.tuesdayData);
    markBasePublished(state.specialData);
    markBasePublished(state.fastingData);

    persistScheduleSnapshots({
      sunday: state.sundayData,
      tuesday: state.tuesdayData,
      special: state.specialData,
      fasting: state.fastingData
    });

    /* Default each tab to the first non-past month (current month), fall back to last */
    const _si  = state.sundayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    state.sundayIdx  = _si  >= 0 ? _si  : Math.max(0, state.sundayData.length  - 1);
    const _ti  = state.tuesdayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    state.tuesdayIdx = _ti  >= 0 ? _ti  : Math.max(0, state.tuesdayData.length - 1);

    /* Special Days: prefer first non-past month, then first with events, else last */
    const _spi = state.specialData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    const _firstWithEvents = state.specialData.findIndex(function(m){ return m.events && m.events.length > 0; });
    state.specialIdx = _spi >= 0 ? _spi : (_firstWithEvents >= 0 ? _firstWithEvents : Math.max(0, state.specialData.length - 1));

    /* Fasting: first non-past month */
    const _fi  = state.fastingData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    state.fastingIdx = _fi >= 0 ? _fi : Math.max(0, state.fastingData.length - 1);

    /* Enable/disable tabs based on current visibility/data */
    refreshAllTabStates();

    /* Gate entire app behind login — no data visible without authentication */
    var resumed = await tryResumeViewerSession();
    if (!resumed) {
      showOtpModal(() => render());
    }
  } catch (err) {
    content.innerHTML = `
      <div class="error-card">
        <strong>Could not load schedule</strong>
        <p>Please check your internet connection and try again.</p>
        <button class="btn-primary" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

async function tryResumeViewerSession() {
  var session = getViewerSession();
  if (!session) return false;

  var profile = await getUserProfile(session.phone);
  if (!profile || profile.active === false || profile.role !== 'viewer') {
    clearViewerSession();
    return false;
  }

  await finalizeAuth(profile, 'session');
  return true;
}

/** Silently re-fetch JSON data in the background and re-render if anything changed */
async function refreshData(forceRender) {
  try {
    var baseData = await fetchBaseScheduleData();
    if (!baseData.sunday.length || !baseData.tuesday.length) return;
    const resolvedData = await resolveScheduleData({
      sunday: baseData.sunday,
      tuesday: baseData.tuesday,
      special: baseData.special.length ? baseData.special : state.specialData,
      fasting: baseData.fasting.length ? baseData.fasting : state.fastingData
    });
    const newSunday  = resolvedData.sunday;
    const newTuesday = resolvedData.tuesday;
    const newSpecial = resolvedData.special;
    const newFasting = resolvedData.fasting;

    markBasePublished(newSunday);
    markBasePublished(newTuesday);
    markBasePublished(newSpecial);
    markBasePublished(newFasting);

    persistScheduleSnapshots({
      sunday: newSunday,
      tuesday: newTuesday,
      special: newSpecial,
      fasting: newFasting
    });

    const changed = JSON.stringify(newSunday)  !== JSON.stringify(state.sundayData)  ||
                    JSON.stringify(newTuesday) !== JSON.stringify(state.tuesdayData) ||
                    JSON.stringify(newSpecial) !== JSON.stringify(state.specialData) ||
                    JSON.stringify(newFasting) !== JSON.stringify(state.fastingData);

    state.sundayData  = newSunday;
    state.tuesdayData = newTuesday;
    state.specialData = newSpecial;
    state.fastingData = newFasting;

    if (changed || forceRender) {
      refreshAllTabStates();
      render();
    }
  } catch (e) { /* silent — don't disrupt the user */ }
}

/* ── Drawer (hamburger menu) ────────────────────────────────────────────── */
window.openMenu = function openMenu() {
  if (!accessRole) return; /* no PIN entered yet — ignore */
  id('drawer').classList.add('open');
  id('drawer-overlay').classList.remove('hidden');
};
window.closeMenu = function closeMenu() {
  id('drawer').classList.remove('open');
  id('drawer-overlay').classList.add('hidden');
};

window.selectTab = function selectTab(tab) {
  closeMenu();
  var btn = id('drawer-' + tab);
  if (btn && (btn.classList.contains('disabled') || btn.classList.contains('hidden-tab'))) return;
  /* Always reset to current (first non-past) month when switching tabs from the drawer */
  var arr  = getTabArr(tab);
  var idxK = getTabIdxKey(tab);
  var ci = arr.findIndex(function(m){
    return !isPastMonth(m.monthKey) && isPublishedFor(m);
  });
  if (ci >= 0) state[idxK] = ci;
  switchTab(tab);
};

/* Sync drawer highlight and header subtitle */
function updateDrawerState(tab) {
  const labels = { sunday: 'Sunday Services', tuesday: 'Tuesday Prayer', special: 'Special Days', fasting: 'Fasting Prayer' };
  ['sunday','tuesday','special','fasting'].forEach(t => {
    const btn = id('drawer-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
  });
  const label = id('header-tab-label');
  if (label) label.textContent = labels[tab] || '';
}

function refreshAllTabStates() {
  const tuesdayBtn = id('drawer-tuesday');
  const specialBtn = id('drawer-special');
  const fastingBtn = id('drawer-fasting');

  if (accessRole === 'viewer') {
    /* Viewer tabs should follow admin publish settings across available months. */
    const hasTuesday = state.tuesdayData.some(function(m){
      return m && m.published !== false;
    });
    if (tuesdayBtn) tuesdayBtn.classList.toggle('hidden-tab', !hasTuesday);

    /* Special: visible if any month is published */
    const hasSpecial = state.specialData.some(function(m){
      return m && m.published !== false;
    });
    if (specialBtn) specialBtn.classList.toggle('hidden-tab', !hasSpecial);

    /* Fasting: visible if any month is published */
    const hasFasting = state.fastingData.some(function(m){
      return m && m.published !== false;
    });
    if (fastingBtn) fastingBtn.classList.toggle('hidden-tab', !hasFasting);

    if (!hasTuesday && state.tab === 'tuesday') { state.tab = 'sunday'; }
    if (!hasSpecial  && state.tab === 'special')  { state.tab = 'sunday'; }
    if (!hasFasting  && state.tab === 'fasting')  { state.tab = 'sunday'; }
  } else {
    /* Admin: always show all tabs */
    if (tuesdayBtn) tuesdayBtn.classList.remove('hidden-tab');
    if (specialBtn) specialBtn.classList.remove('hidden-tab');
    /* Show fasting tab for admin if ANY month exists in the data */
    if (fastingBtn) fastingBtn.classList.toggle('hidden-tab', state.fastingData.length === 0);
  }
}
function refreshSpecialTabState() { refreshAllTabStates(); }

/* ── Tab switching ────────────────────────────────────────────────────────── */
window.switchTab = function switchTab(tab) {
  state.tab = tab;
  updateDrawerState(tab);
  render();
};

/* ── Month navigation ─────────────────────────────────────────────────────── */
window.navigateMonth = function navigateMonth(tab, dir) {
  const arr  = getTabArr(tab);
  const idxK = getTabIdxKey(tab);
  const next = clamp(state[idxK] + dir, 0, arr.length - 1);
  const m    = arr[next];
  /* Viewer: cannot navigate to past months OR unpublished months */
  if (accessRole === 'viewer' && (isPastMonth(m?.monthKey) || m?.published === false)) return;
  /* Admin: can navigate freely */
  state[idxK] = next;
  render();
};

/* ── Tab data helpers ──────────────────────────────────────────────── */
function getTabArr(tab) {
  if (tab === 'sunday')  return state.sundayData;
  if (tab === 'tuesday') return state.tuesdayData;
  if (tab === 'fasting') return state.fastingData;
  return state.specialData;
}
function getTabIdxKey(tab) {
  if (tab === 'sunday')  return 'sundayIdx';
  if (tab === 'tuesday') return 'tuesdayIdx';
  if (tab === 'fasting') return 'fastingIdx';
  return 'specialIdx';
}
/** True if the month is visible to the current role */
function isPublishedFor(m) {
  if (accessRole === 'admin') return true;
  return m.published !== false; /* missing field = legacy, treat as published */
}

/** Keep admin-only controls hidden for non-admin roles */
function syncAdminControls() {
  var menuBtn = id('menu-btn');
  var dlBtn = id('download-btn');
  var usersBtn = id('admin-users-btn');
  var logoutBtn = id('logout-btn');

  if (menuBtn) {
    if (accessRole === 'admin') {
      menuBtn.style.display = '';
      menuBtn.disabled = false;
      menuBtn.setAttribute('title', 'Open menu');
    } else {
      menuBtn.style.display = 'none';
      menuBtn.disabled = true;
      closeMenu();
    }
  }

  if (!accessRole) {
    if (logoutBtn) logoutBtn.remove();
  }
  if (accessRole !== 'admin') {
    if (dlBtn) dlBtn.remove();
    if (usersBtn) usersBtn.remove();
  }

  var header = document.querySelector('.app-header');
  if (!header) return;

  if (accessRole && !logoutBtn) {
    logoutBtn = document.createElement('button');
    logoutBtn.className = 'logout-btn';
    logoutBtn.id = 'logout-btn';
    logoutBtn.setAttribute('aria-label', 'Log out');
    logoutBtn.setAttribute('title', 'Log out');
    logoutBtn.innerHTML = '&#10162;';
    logoutBtn.onclick = window.logoutCurrentSession;
    header.appendChild(logoutBtn);
  } else if (logoutBtn) {
    logoutBtn.setAttribute('title', 'Log out');
  }

  if (accessRole !== 'admin') return;

  if (!usersBtn) {
    usersBtn = document.createElement('button');
    usersBtn.className = 'admin-users-btn';
    usersBtn.id = 'admin-users-btn';
    usersBtn.setAttribute('aria-label', 'Manage users');
    usersBtn.setAttribute('title', 'Manage users');
    usersBtn.innerHTML = '&#128101;';
    usersBtn.onclick = window.openAdminUsersModal;
    header.appendChild(usersBtn);
  } else {
    usersBtn.setAttribute('title', 'Manage users');
  }

  if (!dlBtn) {
    dlBtn = document.createElement('button');
    dlBtn.className = 'download-btn admin-visible';
    dlBtn.id = 'download-btn';
    dlBtn.setAttribute('aria-label', 'Download / Print');
    dlBtn.setAttribute('title', 'Download or print');
    dlBtn.innerHTML = '&#8597;';
    dlBtn.onclick = window.downloadSchedule;
    header.appendChild(dlBtn);
    return;
  }

  dlBtn.setAttribute('title', 'Download or print');
  usersBtn.classList.add('admin-visible');
  dlBtn.classList.add('admin-visible');
}

/* ── Render dispatcher ──────────────────────────────────────────────── */
function render() {
  syncAdminControls();
  updateDrawerState(state.tab);
  if      (state.tab === 'sunday')  renderSunday();
  else if (state.tab === 'tuesday') renderTuesday();
  else if (state.tab === 'fasting') renderFasting();
  else                              renderSpecial();
}

/* ══════════════════════════════════════════════════════════════════════════════
   SUNDAY SERVICES
   ══════════════════════════════════════════════════════════════════════════ */
function renderSunday() {
  const content = id('content');

  if (!state.sundayData.length) {
    content.innerHTML = emptyState('No Sunday schedule data available.');
    return;
  }

  const data    = state.sundayData[state.sundayIdx];
  const sundays = getSundaysOfMonth(data.monthKey);  /* actual calendar dates */

  let html = monthNavHTML(state.sundayIdx, state.sundayData.length, 'sunday', data.month, data.monthKey);

  /* Archive banner for past months */
  if (isPastMonth(data.monthKey)) {
    html += archiveBanner();
  }

  /* Optional notice/notes for the month */
  if (data.notes) {
    html += `<div class="notice-card">📌 ${esc(data.notes)}</div>`;
  }

  /* One card per service time / location */
  data.services.forEach(service => {
    /* Build week column headers — use real dates if available */
    const maxWeeks = Math.max(...service.programs.map(p => p.weeks.length));
    const weekHeaders = Array.from({ length: maxWeeks }, (_, i) => {
      const dateLabel = sundays[i] ? formatShortDate(sundays[i]) : `Wk ${i + 1}`;
      return `<th>${esc(dateLabel)}</th>`;
    }).join('');

    /* Build table rows */
    const rows = service.programs.map(p => {
      const cells = Array.from({ length: maxWeeks }, (_, i) => {
        const val = p.weeks[i];
        return val
          ? `<td>${esc(val)}</td>`
          : `<td class="empty-cell">—</td>`;
      }).join('');
      return `<tr><td class="role-cell">${esc(p.role)}</td>${cells}</tr>`;
    }).join('');

    html += `
      <div class="service-card">
        <div class="service-header">
          <span class="service-time">${esc(service.time)}</span>
          ${service.location ? `<span class="service-location">${esc(service.location)}</span>` : ''}
        </div>
        <div class="table-scroll">
          <table class="schedule-table" role="table">
            <thead>
              <tr>
                <th class="role-col">Program</th>
                ${weekHeaders}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>`;
  });

  html += `<p class="hint">← Swipe table sideways to see all weeks →</p>`;
  content.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════════════════════
   TUESDAY PRAYER
   ══════════════════════════════════════════════════════════════════════════ */
function renderTuesday() {
  const content = id('content');

  if (!state.tuesdayData.length) {
    content.innerHTML = emptyState('No Tuesday prayer for this month.');
    return;
  }

  const data = state.tuesdayData[state.tuesdayIdx];
  let html   = monthNavHTML(state.tuesdayIdx, state.tuesdayData.length, 'tuesday', data.month, data.monthKey);

  /* Archive banner for past months */
  if (isPastMonth(data.monthKey)) {
    html += archiveBanner();
  }

  if (data.notes) {
    html += `<div class="notice-card">📌 ${esc(data.notes)}</div>`;
  }

  if (!data.tuesdays || data.tuesdays.length === 0) {
    html += emptyState('No Tuesday prayer scheduled this month.');
    content.innerHTML = html;
    return;
  }

  data.tuesdays.forEach(tuesday => {
    /* Up to 4 prayer slots */
    const rows = (tuesday.slots || []).map((slot, i) => `
      <tr>
        <td><span class="slot-num">${i + 1}</span></td>
        <td class="slot-name">${esc(slot.name)}</td>
        <td class="slot-area">${esc(slot.area)}</td>
        <td class="slot-pastor">${esc(slot.pastor)}</td>
      </tr>`).join('');

    html += `
      <div class="tuesday-card">
        <div class="tuesday-header">🙏&nbsp; ${esc(tuesday.date)}</div>
        <table class="prayer-table" role="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Area</th>
              <th>Pastor</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
  });

  content.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════════════════════
   SPECIAL DAYS
   ══════════════════════════════════════════════════════════════════════════ */
function renderSpecial() {
  const content = id('content');

  if (!state.specialData.length) {
    content.innerHTML = emptyState('No special days data available.');
    return;
  }

  const data = state.specialData[state.specialIdx];
  let html   = monthNavHTML(state.specialIdx, state.specialData.length, 'special', data.month, data.monthKey);

  if (!data.events || data.events.length === 0) {
    html += `<div class="empty-state">
      <div class="empty-icon">✦</div>
      <p>No special events for ${esc(data.month)}.</p>
    </div>`;
    content.innerHTML = html;
    return;
  }

  data.events.forEach(ev => {
    /* Build program rows — only show fields that have a value */
    const fields = [
      { label: 'Time',           value: ev.time },
      { label: 'Location',       value: ev.location },
      { label: 'Incharge',       value: ev.incharge },
      { label: 'Choir',          value: ev.choir },
      { label: 'Praise Worship', value: ev.praiseWorship },
      { label: 'Sermon By',      value: ev.sermonBy },
      { label: 'Translation',    value: ev.translation },
      { label: 'Preaching',      value: ev.preaching }
    ].filter(f => f.value);

    const rows = fields.map(f => `
      <tr>
        <td class="sp-label">${esc(f.label)}</td>
        <td class="sp-value">${esc(f.value)}</td>
      </tr>`).join('');

    html += `
      <div class="special-card">
        <div class="special-header">
          <div class="special-title-row">
            <span class="special-title">${esc(ev.title)}</span>
            <span class="special-day-badge">${esc(ev.day || '')}</span>
          </div>
          <span class="special-date">${esc(ev.date)}</span>
        </div>
        <table class="sp-table">
          <tbody>${rows}</tbody>
        </table>
        ${ev.notes ? `<div class="special-notes">📌 ${esc(ev.notes)}</div>` : ''}
      </div>`;
  });

  content.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════════════════════
   FASTING PRAYER
   ══════════════════════════════════════════════════════════════════════════ */
function renderFasting() {
  const content = id('content');

  if (!state.fastingData.length) {
    content.innerHTML = emptyState('No fasting prayer data available.');
    return;
  }

  /* Viewer: must not see unpublished months */
  const data = state.fastingData[state.fastingIdx];
  if (!data) { content.innerHTML = emptyState('No fasting prayer data available.'); return; }
  if (accessRole === 'viewer' && data.published === false) {
    content.innerHTML = emptyState('No fasting prayer scheduled.');
    return;
  }

  let html = monthNavHTML(state.fastingIdx, state.fastingData.length, 'fasting', data.month, data.monthKey);

  if (isPastMonth(data.monthKey)) {
    html += archiveBanner();
  }

  if (data.notes) {
    html += `<div class="notice-card">📌 ${esc(data.notes)}</div>`;
  }

  if (!data.sessions || data.sessions.length === 0) {
    html += `<div class="fasting-card">
      <div class="fasting-title-bar">&#9670;&nbsp; Fasting Prayer &mdash; ${esc(data.month)}</div>
      ${emptyState('No fasting prayer sessions for ' + esc(data.month) + '.')}
    </div>`;
    content.innerHTML = html;
    return;
  }

  const rows = data.sessions.map(s => `
    <tr>
      <td class="fast-date">${esc(s.date)}</td>
      <td class="fast-day">${esc(s.day)}</td>
      <td>${esc(s.worshipBy || '—')}</td>
      <td>${esc(s.sermonBy || '—')}</td>
    </tr>`).join('');

  html += `
    <div class="fasting-card">
      <div class="fasting-title-bar">&#9670;&nbsp; Fasting Prayer &mdash; ${esc(data.month)}</div>
      <div class="table-scroll">
        <table class="fasting-table" role="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Day</th>
              <th>Worship By</th>
              <th>Sermon By</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </div>`;

  content.innerHTML = html;
}

/* ══════════════════════════════════════════════════════════════════════════════
   PUBLISH TOGGLE — FIRESTORE
   ══════════════════════════════════════════════════════════════════════════ */
window.togglePublish = async function togglePublish(tab, monthKey, newValue) {
  if (accessRole !== 'admin') return;
  var db = getDb();
  /* Update local state immediately so UI reflects the change at once */
  const localArr = getTabArr(tab);
  const localMonth = localArr.find(m => m.monthKey === monthKey);
  if (localMonth) localMonth.published = newValue;
  var localVisibility = getLocalVisibilityMap();
  localVisibility[monthDocId(tab, monthKey)] = {
    tab: tab,
    monthKey: monthKey,
    published: !!newValue,
    updatedBy: authenticatedPhoneNumber || null,
    updatedAt: Date.now()
  };
  setLocalVisibilityMap(localVisibility);
  refreshAllTabStates();
  render();

  if (!db) return;

  try {
    await db.collection(FS_VISIBILITY_COLLECTION).doc(monthDocId(tab, monthKey)).set({
      tab: tab,
      monthKey: monthKey,
      published: !!newValue,
      updatedBy: authenticatedPhoneNumber || null,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    });
  } catch (err) {
    console.warn('Publish toggle Firestore error:', err.message);
    alert('Could not save publish change. Check Firebase Firestore setup and rules.');
  }
};

/* ══════════════════════════════════════════════════════════════════════════════
   HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

/** Build month navigation bar HTML */
function monthNavHTML(idx, total, tab, monthName, monthKey) {
  const arr    = getTabArr(tab);
  const prevIdx = idx - 1;

  /* Viewer: prev button hidden when previous month is past OR unpublished */
  const viewerMode = (accessRole === 'viewer');
  const prevIsArchived = prevIdx >= 0 && isPastMonth(arr[prevIdx]?.monthKey);
  const prevIsBlocked  = prevIsArchived || (viewerMode && prevIdx >= 0 && arr[prevIdx]?.published === false);
  const prevOff = (idx === 0 || prevIsBlocked) ? 'disabled' : '';

  /* Viewer: next button disabled when next month is unpublished */
  const nextMonth     = arr[idx + 1];
  const nextUnpublished = viewerMode && nextMonth && nextMonth.published === false;
  const nextOff = (idx >= total - 1 || nextUnpublished) ? 'disabled' : '';

  const archiveLock = (prevIsArchived && accessRole === 'admin') ? ' 🔒' : '';
  let roleBadge = '';
  if (accessRole === 'admin')  roleBadge = '<span class="role-badge admin-badge">Admin</span>';
  if (accessRole === 'viewer') roleBadge = '<span class="role-badge viewer-badge">Viewer</span>';

  /* Hide prev button entirely for viewers past the archive boundary */
  const prevHidden = (viewerMode && prevIsArchived) ? 'style="display:none"' : '';

  var monthEl = accessRole === 'admin'
    ? '<button class="month-name-btn" onclick="showMonthPicker(\'' + tab + '\')" aria-label="Pick month">' + esc(monthName) + roleBadge + '<span class="picker-hint">&#9660;</span></button>'
    : '<span class="month-name">' + esc(monthName) + roleBadge + '</span>';

  /* Publish toggle — admin only */
  var publishRow = '';
  if (accessRole === 'admin') {
    const isPublished = (arr[idx]?.published !== false);
    const toggleId    = 'ptog-' + tab + '-' + monthKey.replace(/-/g,'');
    publishRow = '<div class="publish-bar">'
      + '<span class="publish-bar-label">'
      + (isPublished ? '&#128065; Visible to <strong>all users</strong>' : '&#128274; <strong>Hidden</strong> from viewers')
      + '</span>'
      + '<label class="toggle-switch" title="Toggle viewer visibility">'
      + '<input type="checkbox" id="' + toggleId + '"'
      + (isPublished ? ' checked' : '')
      + ' onchange="togglePublish(\'' + tab + '\',\'' + monthKey + '\',this.checked)">'
      + '<span class="toggle-slider"></span>'
      + '</label>'
      + '</div>';
  }

  return '<div class="month-nav">'
    + '<button class="nav-btn" onclick="navigateMonth(\'' + tab + '\',-1)" ' + prevOff + ' ' + prevHidden + ' aria-label="Previous month">&#8249;' + esc(archiveLock) + '</button>'
    + monthEl
    + '<button class="nav-btn" onclick="navigateMonth(\'' + tab + '\',1)" ' + nextOff + ' aria-label="Next month">&#8250;</button>'
    + '</div>'
    + publishRow;
}

/** Return true when monthKey ("YYYY-MM") is strictly before the current calendar month */
function isPastMonth(monthKey) {
  if (!monthKey) return false;
  const now     = new Date();
  const current = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2,'0')}`;
  return monthKey < current;
}

/** Yellow "read-only archive" banner */
function archiveBanner() {
  const roleNote = accessRole === 'admin'
    ? ' &nbsp;<span class="admin-note">(Admin view)</span>'
    : '';
  return `<div class="archive-banner">🔒 Archived — read-only${roleNote}</div>`;
}

/* ════════════════════════════════════════════════════════════════════════════════
   PIN LOGIN MODAL & AUTHENTICATION
   ════════════════════════════════════════════════════════════════════════════════ */
let _authCallback = null;

/** Show the login modal; onSuccess() called once user is authenticated */
function showOtpModal(onSuccess) {
  _authCallback = onSuccess;
  id('otp-modal').classList.remove('hidden');
  showPinLoginStep();
}

function showPinLoginStep() {
  id('pin-create-step').classList.add('hidden');
  id('pin-login-step').classList.remove('hidden');
  id('pin-error').textContent = '';
  id('pin-input').value = '';
  setTimeout(function() { id('pin-phone-input').focus(); }, 80);
}

function showPinCreateStep() {
  id('pin-login-step').classList.add('hidden');
  id('pin-create-step').classList.remove('hidden');
  id('pin-create-error').textContent = '';
  id('new-pin-input').value = '';
  id('confirm-new-pin-input').value = '';
  setTimeout(function() { id('new-pin-input').focus(); }, 80);
}

window.showCreatePin = function showCreatePin() {
  id('pin-create-phone-input').value = id('pin-phone-input').value.trim();
  showPinCreateStep();
};

window.backToPinLogin = function backToPinLogin() {
  showPinLoginStep();
};

function showLockedState() {
  id('content').innerHTML = `
    <div style="text-align:center;padding:60px 24px;">
      <div style="font-size:48px;margin-bottom:16px;">🔐</div>
      <p style="font-size:16px;font-weight:600;color:#374151;margin-bottom:8px;">Schedule is locked</p>
      <p style="font-size:13px;color:#6b7280;margin-bottom:24px;">Use phone number and PIN to unlock the app.</p>
      <button class="otp-submit" style="max-width:220px;margin:0 auto;" onclick="showOtpModal(() => render())">Sign In</button>
    </div>`;
}

async function finalizeAuth(profile, method) {
  if (!profile || profile.active === false || !profile.role) {
    throw new Error('This phone number is not authorized. Contact your administrator.');
  }

  authenticatedPhoneNumber = profile.phone;
  accessRole = profile.role;
  currentUserProfile = profile;

  if (accessRole === 'admin') {
    clearViewerSession();
    if (!tryAcquireAdminLock()) {
      accessRole = null;
      authenticatedPhoneNumber = null;
      currentUserProfile = null;
      throw new Error('Admin is already logged in on another active session. Try again later.');
    }
    const _asi = state.sundayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_asi >= 0) state.sundayIdx = _asi;
    const _ati = state.tuesdayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_ati >= 0) state.tuesdayIdx = _ati;
    const _aspi = state.specialData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_aspi >= 0) state.specialIdx = _aspi;
    const _afi = state.fastingData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_afi >= 0) state.fastingIdx = _afi;
    subscribeVisibilityOverrides();
    subscribeAdminUsers();
  } else {
    function _firstVisible(arr) {
      var i = arr.findIndex(function(m){ return !isPastMonth(m.monthKey) && m.published !== false; });
      if (i >= 0) return i;
      i = arr.findIndex(function(m){ return m.published !== false; });
      return i >= 0 ? i : 0;
    }
    state.sundayIdx  = _firstVisible(state.sundayData);
    state.tuesdayIdx = _firstVisible(state.tuesdayData);
    state.specialIdx = _firstVisible(state.specialData);
    state.fastingIdx = _firstVisible(state.fastingData);
    subscribeVisibilityOverrides();
  }

  if (accessRole === 'viewer') {
    setViewerSession(profile.phone);
  }

  if (method !== 'session') {
    clearPinAttemptState(profile.phone);
    await markPinLogin(profile);
  }

  pendingPinChangeProfile = null;

  syncAdminControls();
  id('otp-modal').classList.add('hidden');
  if (_authCallback) { _authCallback(); _authCallback = null; }
}

window.loginWithPin = async function loginWithPin() {
  var phoneNumber = normalizePhoneNumber(id('pin-phone-input').value.trim());
  var pin = id('pin-input').value.trim();
  var errorEl = id('pin-error');
  errorEl.textContent = '';

  if (!phoneNumber) {
    errorEl.textContent = 'Enter a valid phone number.';
    return;
  }
  if (!/^\d{4,6}$/.test(pin)) {
    errorEl.textContent = 'PIN must be numeric.';
    return;
  }

  var blockMessage = pinBlockedMessage(phoneNumber);
  if (blockMessage) {
    errorEl.textContent = blockMessage;
    return;
  }

  try {
    var profile = await getUserProfile(phoneNumber);
    if (!profile || profile.active === false || !(profile.role === 'admin' || profile.role === 'viewer')) {
      errorEl.textContent = 'This phone number is not authorized.';
      return;
    }
    if (!profile.pinHash && !profile.pinPlain) {
      errorEl.textContent = 'PIN login is not enabled yet for this user. Ask an admin to set a PIN.';
      return;
    }

    var legacyFourDigit = /^\d{4}$/.test(pin);
    var strictSixDigit = /^\d{6}$/.test(pin);

    var pinMatched = false;
    if (profile.pinPlain && safeEqual(pin, profile.pinPlain)) {
      pinMatched = true;
    } else if (profile.pinHash) {
      var candidateHash = await hashPin(phoneNumber, pin);
      pinMatched = safeEqual(candidateHash, profile.pinHash);
    }
    if (!pinMatched) {
      var attemptState = recordFailedPinAttempt(phoneNumber);
      errorEl.textContent = attemptState.blockedUntil > Date.now()
        ? pinBlockedMessage(phoneNumber)
        : 'Incorrect PIN. Try again.';
      id('pin-input').value = '';
      id('pin-input').focus();
      return;
    }

    if (legacyFourDigit && !strictSixDigit) {
      pendingPinChangeProfile = profile;
      id('pin-create-phone-input').value = phoneNumber;
      showPinCreateStep();
      id('pin-create-error').textContent = 'Your old PIN is accepted one last time. Set a new 6 digit PIN to continue.';
      return;
    }

    if (profile.pinMustChange === true) {
      pendingPinChangeProfile = profile;
      id('pin-create-phone-input').value = phoneNumber;
      showPinCreateStep();
      id('pin-create-error').textContent = 'Create a new 6 digit PIN to continue.';
      return;
    }

    await finalizeAuth(profile, 'pin');
  } catch (err) {
    console.error('PIN Login Error:', err);
    errorEl.textContent = err.message || 'Could not complete PIN login.';
  }
};

window.saveOwnPin = async function saveOwnPin() {
  var phoneNumber = normalizePhoneNumber(id('pin-create-phone-input').value.trim());
  var newPin = id('new-pin-input').value.trim();
  var confirmPin = id('confirm-new-pin-input').value.trim();
  var errEl = id('pin-create-error');
  errEl.textContent = '';

  if (!phoneNumber) {
    errEl.textContent = 'Enter a valid phone number.';
    return;
  }
  if (!isValidPin(newPin)) {
    errEl.textContent = 'PIN must be exactly 6 digits.';
    return;
  }
  var policyError = validatePinPolicy(phoneNumber, newPin);
  if (policyError) {
    errEl.textContent = policyError;
    return;
  }
  if (isPinDuplicateForAnotherUser(phoneNumber, newPin)) {
    errEl.textContent = 'This PIN is already used by another user. Use a unique PIN.';
    return;
  }
  if (newPin !== confirmPin) {
    errEl.textContent = 'PIN confirmation does not match.';
    return;
  }

  var forcedFirstLoginChange = !!(pendingPinChangeProfile && pendingPinChangeProfile.phone === phoneNumber);
  var adminOverrideChange = (accessRole === 'admin');
  var selfAfterLoginChange = (accessRole === 'viewer' && authenticatedPhoneNumber === phoneNumber);
  var canChange = forcedFirstLoginChange || adminOverrideChange || selfAfterLoginChange;
  if (!canChange) {
    errEl.textContent = 'Login with your assigned PIN first, then change it.';
    return;
  }

  try {
    var profile = await getUserProfile(phoneNumber);
    if (!profile || profile.active === false || !(profile.role === 'admin' || profile.role === 'viewer')) {
      errEl.textContent = 'This phone number is not authorized.';
      return;
    }

    var existingSelfChanges = Number(profile.selfPinChangeCount || 0);
    if (selfAfterLoginChange && existingSelfChanges >= SELF_PIN_CHANGE_LIMIT) {
      errEl.textContent = 'You have reached your PIN change limit. Contact admin for reset.';
      return;
    }

    var nextSelfChangeCount = existingSelfChanges + (selfAfterLoginChange ? 1 : 0);

    var payload = {
      phone: phoneNumber,
      username: sanitizeUsername(profile.username, profile.role === 'admin' ? 'Admin' : 'User'),
      role: profile.role,
      active: true,
      pinPlain: newPin,
      pinHash: await hashPin(phoneNumber, newPin),
      pinVersion: 1,
      pinMustChange: false,
      selfPinChangeCount: nextSelfChangeCount,
      updatedBy: authenticatedPhoneNumber || phoneNumber
    };

    upsertLocalUser(phoneNumber, Object.assign({}, payload, {
      pinUpdatedAt: Date.now(),
      updatedAt: Date.now()
    }));

    var db = getDb();
    if (db) {
      await db.collection(FS_USERS_COLLECTION).doc(phoneNumber).set(Object.assign({}, payload, {
        pinUpdatedAt: firebase.firestore.FieldValue.serverTimestamp(),
        updatedAt: firebase.firestore.FieldValue.serverTimestamp()
      }), { merge: true });
    }

    id('pin-phone-input').value = phoneNumber;
    id('pin-input').value = '';
    showPinLoginStep();
    if (pendingPinChangeProfile && pendingPinChangeProfile.phone === phoneNumber) {
      var updatedProfile = Object.assign({}, pendingPinChangeProfile, payload, { phone: phoneNumber });
      await finalizeAuth(updatedProfile, 'pin');
      return;
    }

    id('pin-error').textContent = 'PIN saved. You can login now.';
  } catch (err) {
    console.warn('Save own PIN error:', err.message);
    errEl.textContent = 'Could not save PIN right now.';
  }
};

/** Close modal without authenticating */
window.cancelOtp = function cancelOtp() {
  id('otp-modal').classList.add('hidden');
  pendingPinChangeProfile = null;
  _authCallback = null;
  showLockedState();
};

window.logoutCurrentSession = async function logoutCurrentSession() {
  releaseAdminLock();
  stopFirestoreSubscriptions();
  clearViewerSession();
  pendingPinChangeProfile = null;
  accessRole = null;
  authenticatedPhoneNumber = null;
  currentUserProfile = null;
  syncAdminControls();
  showLockedState();
};

/* ── Refresh app ────────────────────────────────────────────────── */
window.refreshApp = function refreshApp() {
  if (!accessRole) return; /* not authenticated yet */
  var btn = id('refresh-btn');
  if (btn) btn.classList.add('spinning');
  /* Render immediately from current state so UI feels instant */
  render();
  /* Fetch fresh data in background — stop spinner when done */
  refreshData(true).finally(function() {
    if (btn) btn.classList.remove('spinning');
  });
};

/* ── Admin download / print ─────────────────────────────────────── */
window.downloadSchedule = function downloadSchedule() {
  if (accessRole !== 'admin') return;

  /* Determine which tab is active and pick the matching data + index */
  var tabLabel, data, sundays;
  if (state.tab === 'sunday') {
    data      = state.sundayData[state.sundayIdx];
    sundays   = getSundaysOfMonth(data ? data.monthKey : null);
    tabLabel  = 'Sunday Services';
  } else if (state.tab === 'tuesday') {
    data      = state.tuesdayData[state.tuesdayIdx];
    tabLabel  = 'Tuesday Prayer';
  } else if (state.tab === 'fasting') {
    data      = state.fastingData[state.fastingIdx];
    tabLabel  = 'Fasting Prayer';
  } else {
    data      = state.specialData[state.specialIdx];
    tabLabel  = 'Special Days';
  }

  if (!data) { alert('No data available to print.'); return; }

  var monthTitle = data.month || '';

  /* ── Build inner HTML for the section ── */
  var bodyHTML = '';

  if (state.tab === 'sunday') {
    if (!data.services || data.services.length === 0) {
      bodyHTML = '<p>No services scheduled this month.</p>';
    } else {
      data.services.forEach(function(service) {
        var maxWeeks = Math.max.apply(null, service.programs.map(function(p){ return p.weeks.length; }));
        var headerCells = '<th class="role-col">Program</th>';
        for (var i = 0; i < maxWeeks; i++) {
          var label = sundays[i] ? sundays[i].toLocaleDateString('en-US', { month:'short', day:'numeric' }) : ('Wk '+(i+1));
          headerCells += '<th>' + htmlEsc(label) + '</th>';
        }
        /* Compute rowspan: merge consecutive rows that share the same
           non-empty value in a given week column ("Easter Service" etc.) */
        var numRows = service.programs.length;
        var skipCell = [], rowspanVal = [];
        for (var r = 0; r < numRows; r++) { skipCell[r] = {}; rowspanVal[r] = {}; }
        for (var col = 0; col < maxWeeks; col++) {
          var r = 0;
          while (r < numRows) {
            var colVal = service.programs[r].weeks[col] || '';
            if (!colVal) { r++; continue; }
            var span = 1;
            while (r + span < numRows && (service.programs[r + span].weeks[col] || '') === colVal) { span++; }
            if (span > 1) {
              rowspanVal[r][col] = span;
              for (var s = 1; s < span; s++) { skipCell[r + s][col] = true; }
            }
            r += span;
          }
        }
        var rows = service.programs.map(function(p, rowIdx) {
          var cells = '<td class="role-col">' + htmlEsc(p.role) + '</td>';
          for (var i = 0; i < maxWeeks; i++) {
            if (skipCell[rowIdx][i]) continue;
            var val = p.weeks[i];
            var rs = rowspanVal[rowIdx][i] ? ' rowspan="' + rowspanVal[rowIdx][i] + '" class="merged-cell"' : '';
            cells += val ? '<td' + rs + '>' + htmlEsc(val) + '</td>' : '<td class="empty">—</td>';
          }
          return '<tr>' + cells + '</tr>';
        }).join('');

        bodyHTML += '<div class="service-block">'
          + '<h3>' + htmlEsc(service.time)
          + (service.location ? ' &mdash; ' + htmlEsc(service.location) : '')
          + '</h3>'
          + '<table><thead><tr>' + headerCells + '</tr></thead><tbody>' + rows + '</tbody></table>'
          + '</div>';
      });
    }
  } else if (state.tab === 'tuesday') {
    if (!data.tuesdays || data.tuesdays.length === 0) {
      bodyHTML = '<p>No Tuesday prayer sessions this month.</p>';
    } else {
      data.tuesdays.forEach(function(tuesday) {
        var rows = (tuesday.slots || []).map(function(slot, i) {
          return '<tr><td>' + (i+1) + '</td><td>' + htmlEsc(slot.name)
            + '</td><td>' + htmlEsc(slot.area)
            + '</td><td>' + htmlEsc(slot.pastor) + '</td></tr>';
        }).join('');
        bodyHTML += '<div class="service-block">'
          + '<h3>🙏 ' + htmlEsc(tuesday.date) + '</h3>'
          + '<table><thead><tr><th>#</th><th>Name</th><th>Area</th><th>Pastor</th></tr></thead>'
          + '<tbody>' + rows + '</tbody></table>'
          + '</div>';
      });
    }
  } else if (state.tab === 'fasting') {
    if (!data.sessions || data.sessions.length === 0) {
      bodyHTML = '<p>No fasting prayer sessions this month.</p>';
    } else {
      var rows = data.sessions.map(function(s) {
        return '<tr><td>' + htmlEsc(s.date) + '</td><td>' + htmlEsc(s.day)
          + '</td><td>' + htmlEsc(s.worshipBy || '—')
          + '</td><td>' + htmlEsc(s.sermonBy  || '—') + '</td></tr>';
      }).join('');
      bodyHTML = '<div class="service-block">'
        + '<h3>&#9670; Fasting Prayer &mdash; ' + htmlEsc(data.month) + '</h3>'
        + '<table><thead><tr><th>Date</th><th>Day</th><th>Worship By</th><th>Sermon By</th></tr></thead>'
        + '<tbody>' + rows + '</tbody></table>'
        + '</div>';
    }
  } else {
    if (!data.events || data.events.length === 0) {
      bodyHTML = '<p>No special events this month.</p>';
    } else {
      data.events.forEach(function(ev) {
        var fields = [
          { label:'Time',           value:ev.time },
          { label:'Location',       value:ev.location },
          { label:'Incharge',       value:ev.incharge },
          { label:'Choir',          value:ev.choir },
          { label:'Praise Worship', value:ev.praiseWorship },
          { label:'Sermon By',      value:ev.sermonBy },
          { label:'Translation',    value:ev.translation },
          { label:'Preaching',      value:ev.preaching }
        ].filter(function(f){ return f.value; });
        var rows = fields.map(function(f){
          return '<tr><td class="sp-label">' + htmlEsc(f.label) + '</td><td>' + htmlEsc(f.value) + '</td></tr>';
        }).join('');
        bodyHTML += '<div class="service-block">'
          + '<h3>' + htmlEsc(ev.title) + (ev.day ? ' &mdash; ' + htmlEsc(ev.day) : '') + '</h3>'
          + '<p class="ev-date">' + htmlEsc(ev.date) + '</p>'
          + '<table><tbody>' + rows + '</tbody></table>'
          + '</div>';
      });
    }
  }

  /* ── Assemble full printable HTML page ── */
  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>Peter Foundation Church &mdash; ' + htmlEsc(tabLabel) + ' &mdash; ' + htmlEsc(monthTitle) + '</title>'
    + '<style>'
    + 'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:20px;color:#111;background:#fff;font-weight:700;}'
    + '.print-header{text-align:center;margin-bottom:24px;border-bottom:2px solid #333;padding-bottom:12px;}'
    + '.print-header h1{margin:0 0 4px;font-size:22px;font-weight:700;}'
    + '.print-header h2{margin:0;font-size:16px;font-weight:700;color:#111;}'
    + '.service-block{margin-bottom:28px;}'
    + '.service-block h3{font-size:15px;margin:0 0 8px;padding:6px 10px;background:#f3f4f6;border-left:4px solid #1a56db;font-weight:700;}'
    + '.ev-date{margin:0 0 8px;font-size:13px;color:#111;font-weight:700;}'
    + '.print-actions{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;margin:0 auto 24px;}'
    + '.print-action-btn{padding:10px 20px;font-size:15px;border:none;border-radius:8px;cursor:pointer;}'
    + '.print-btn-primary{background:#1a56db;color:#fff;}'
    + '.print-btn-secondary{background:#e5e7eb;color:#111827;}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px;table-layout:fixed;}'
    + 'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;vertical-align:top;white-space:normal;overflow-wrap:anywhere;word-break:break-word;}'
    + 'th{background:#e5e7eb;font-weight:700;}'
    + '.role-col{width:170px;font-weight:700;background:#f9fafb;}'
    + '.merged-cell{vertical-align:middle!important;text-align:center;background:#eef2ff;font-weight:700;white-space:normal;overflow-wrap:anywhere;word-break:break-word;}'
    + '.sp-label{font-weight:700;width:130px;background:#f9fafb;}'
    + '.empty{color:#aaa;text-align:center;}'
    + '@media print{'
    + '  body{padding:0;}'
    + '  .no-print{display:none!important;}'
    + '  .service-block{page-break-inside:avoid;}'
    + '}'
    + '</style></head><body>'
    + '<div class="print-header">'
    + '<h1>Peter Foundation Church</h1>'
    + '<h2>' + htmlEsc(tabLabel) + ' &mdash; ' + htmlEsc(monthTitle) + '</h2>'
    + '</div>'
    + '<div class="print-actions no-print">'
    + '<button class="print-action-btn print-btn-primary" onclick="window.print()">&#128438; Print / Save as PDF</button>'
    + '<button class="print-action-btn print-btn-secondary" onclick="window.close()">Close</button>'
    + '</div>'
    + bodyHTML
    + '</body></html>';

  var win = window.open('', '_blank');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
  win.focus();
};

/** HTML-escape helper used in print page generation */
function htmlEsc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* ── Admin month picker ───────────────────────────────────────────── */
var _pickerTab = null;

window.showMonthPicker = function showMonthPicker(tab) {
  if (accessRole !== 'admin') return;
  _pickerTab = tab;
  var arr    = getTabArr(tab);
  var idxK   = getTabIdxKey(tab);
  var curIdx = state[idxK];
  var sel = id('picker-select');
  if (!sel) return;
  sel.innerHTML = arr.map(function(m, i) {
    return '<option value="' + i + '"' + (i === curIdx ? ' selected' : '') + '>' + esc(m.month) + '</option>';
  }).join('');
  id('month-picker').classList.remove('hidden');
};

window.jumpToMonth = function jumpToMonth() {
  var sel  = id('picker-select');
  var idxK = getTabIdxKey(_pickerTab);
  state[idxK] = parseInt(sel.value, 10);
  id('month-picker').classList.add('hidden');
  render();
};

window.closePicker = function closePicker() {
  id('month-picker').classList.add('hidden');
};


/** Allow keyboard submit/cancel for login modal */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !id('otp-modal').classList.contains('hidden')) {
    if (!id('pin-create-step').classList.contains('hidden')) saveOwnPin();
    else loginWithPin();
  }
  if (e.key === 'Escape' && !id('otp-modal').classList.contains('hidden')) {
    cancelOtp();
  }
});

/**
 * Returns an array of Date objects for every Sunday in the given month.
 * monthKey format: "YYYY-MM"  e.g. "2026-04"
 */
function getSundaysOfMonth(monthKey) {
  if (!monthKey) return [];
  const [year, month] = monthKey.split('-').map(Number);
  const sundays = [];
  const d = new Date(year, month - 1, 1);
  /* Advance to first Sunday */
  while (d.getDay() !== 0) d.setDate(d.getDate() + 1);
  while (d.getMonth() === month - 1) {
    sundays.push(new Date(d));
    d.setDate(d.getDate() + 7);
  }
  return sundays;
}

/** e.g.  Date → "Apr 5" */
function formatShortDate(date) {
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Empty-state placeholder */
function emptyState(msg) {
  return `<div class="empty-state">
    <div class="empty-icon">📅</div>
    <p>${esc(msg)}</p>
  </div>`;
}

/** Clamp a value between min and max */
function clamp(v, min, max) {
  return Math.min(Math.max(v, min), max);
}

/** document.getElementById shorthand */
function id(elementId) {
  return document.getElementById(elementId);
}

/** HTML-escape a string to prevent XSS */
function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
