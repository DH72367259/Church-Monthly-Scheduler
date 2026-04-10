/* ─── Worship Library — Church Schedule App ─────────────────────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════════════════════════
   ACCESS PINs — stored as SHA-256 hashes (never as plaintext).
   To change a PIN: compute sha256(newPin) and replace the hash below.
   VIEWER_HASH : congregation members — current month only.
   ADMIN_HASH  : admin — all months + Admin badge.
   ══════════════════════════════════════════════════════════════════════════ */
const VIEWER_HASH = '7599dc4548df450045cf9bc258c43c654ea6d4af04074eb0292262e3d5187d5b';
const ADMIN_HASH  = '594686bcfe8a1c52aa5c6ab2feadeac31c7fbc9815ad68487b60d946a12e4765';

/* ── GitHub API config (for publish toggle) ──────────────────────────────── */
const GH_OWNER     = 'DH72367259';
const GH_REPO      = 'Church-Monthly-Scheduler';
const GH_BRANCH    = 'main';
const GH_TOKEN_KEY = 'pf_gh_token'; /* localStorage key — stays on this device */

/* ── Admin one-session lock (browser-level) ─────────────────────────────── */
const ADMIN_LOCK_KEY        = 'pf_admin_lock';
const ADMIN_LOCK_TTL_MS     = 90000; /* stale lock expires after 90s */
const ADMIN_HEARTBEAT_MS    = 15000;
const ADMIN_SESSION_ID_KEY  = 'pf_admin_session_id';
const ADMIN_SESSION_ID      = (function() {
  var sid = sessionStorage.getItem(ADMIN_SESSION_ID_KEY);
  if (sid) return sid;
  sid = 'adm_' + Date.now() + '_' + Math.random().toString(36).slice(2);
  sessionStorage.setItem(ADMIN_SESSION_ID_KEY, sid);
  return sid;
})();
let _adminHeartbeatTimer = null;

/** SHA-256 hash of a string via Web Crypto API */
async function sha256(text) {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,'0')).join('');
}

/* Session-level access role: null | 'viewer' | 'admin' */
let accessRole = null;  /* PIN required on every app load */

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
    /* Cache-bust with a timestamp so admins' Git pushes are visible immediately */
    const ts = '?t=' + Date.now();
    const [sr, tr, xr, fr] = await Promise.all([
      fetch('./data/sunday-schedule.json' + ts),
      fetch('./data/tuesday-prayer.json'  + ts),
      fetch('./data/special-days.json'    + ts),
      fetch('./data/fasting-prayer.json'  + ts)
    ]);
    if (!sr.ok) throw new Error('sunday-schedule.json not found');
    if (!tr.ok) throw new Error('tuesday-prayer.json not found');

    state.sundayData  = await sr.json();
    state.tuesdayData = await tr.json();

    /* Special days — gracefully optional */
    if (xr.ok) {
      state.specialData = await xr.json();
    }

    /* Fasting prayer — gracefully optional */
    if (fr.ok) {
      state.fastingData = await fr.json();
    }

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

    /* Enable/disable the Special Days tab based on whether ANY events exist */
    refreshAllTabStates();

    /* Gate entire app behind PIN — no data visible without a valid PIN */
    showPinModal(() => render());
  } catch (err) {
    content.innerHTML = `
      <div class="error-card">
        <strong>Could not load schedule</strong>
        <p>Please check your internet connection and try again.</p>
        <button class="btn-primary" onclick="location.reload()">Retry</button>
      </div>`;
  }
}

/** Silently re-fetch JSON data in the background and re-render if anything changed */
async function refreshData(forceRender) {
  try {
    const ts = '?t=' + Date.now();
    const [sr, tr, xr, fr] = await Promise.all([
      fetch('./data/sunday-schedule.json' + ts),
      fetch('./data/tuesday-prayer.json'  + ts),
      fetch('./data/special-days.json'    + ts),
      fetch('./data/fasting-prayer.json'  + ts)
    ]);
    if (!sr.ok || !tr.ok) return; /* silently skip on network error */
    const newSunday  = await sr.json();
    const newTuesday = await tr.json();
    const newSpecial = xr.ok ? await xr.json() : state.specialData;
    const newFasting = fr.ok ? await fr.json() : state.fastingData;

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
  const now    = new Date();
  const curKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

  const tuesdayBtn = id('drawer-tuesday');
  const specialBtn = id('drawer-special');
  const fastingBtn = id('drawer-fasting');

  if (accessRole === 'viewer') {
    /* Tuesday: visible if current month is published AND has sessions */
    const td = state.tuesdayData.find(function(m){ return m.monthKey === curKey; });
    const hasTuesday = !!(td && td.published !== false && td.tuesdays && td.tuesdays.length > 0);
    if (tuesdayBtn) tuesdayBtn.classList.toggle('hidden-tab', !hasTuesday);

    /* Special: visible if any published month has events */
    const hasSpecial = state.specialData.some(function(m){
      return m.published !== false && m.events && m.events.length > 0;
    });
    if (specialBtn) specialBtn.classList.toggle('hidden-tab', !hasSpecial);

    /* Fasting: visible if any published month has sessions */
    const hasFasting = state.fastingData.some(function(m){
      return m.published !== false && m.sessions && m.sessions.length > 0;
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
  var dlBtn = id('download-btn');
  if (accessRole !== 'admin') {
    if (dlBtn) dlBtn.remove();
    return;
  }

  /* Admin: ensure the button exists even if stale cached HTML removed it */
  if (!dlBtn) {
    var header = document.querySelector('.app-header');
    if (!header) return;
    dlBtn = document.createElement('button');
    dlBtn.className = 'download-btn admin-visible';
    dlBtn.id = 'download-btn';
    dlBtn.setAttribute('aria-label', 'Download / Print');
    dlBtn.innerHTML = '&#8597;';
    dlBtn.onclick = window.downloadSchedule;
    header.appendChild(dlBtn);
    return;
  }

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
   PUBLISH TOGGLE — GitHub API
   ══════════════════════════════════════════════════════════════════════════ */
const _GH_FILE_MAP = {
  sunday:  'data/sunday-schedule.json',
  tuesday: 'data/tuesday-prayer.json',
  special: 'data/special-days.json',
  fasting: 'data/fasting-prayer.json'
};

/** Encode a UTF-8 string to base64 (handles non-ASCII) */
function _toBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

/**
 * Toggle the `published` flag for a month via GitHub API.
 * Admin only. Updates local state immediately for instant UI feedback.
 * Changes are live for all users after GitHub Pages re-deploys (~30–60 s).
 */
window.togglePublish = async function togglePublish(tab, monthKey, newValue) {
  if (accessRole !== 'admin') return;

  /* Update local state immediately so UI reflects the change at once */
  const localArr = getTabArr(tab);
  const localMonth = localArr.find(m => m.monthKey === monthKey);
  if (localMonth) localMonth.published = newValue;
  refreshAllTabStates();
  render();

  /* Attempt to persist via GitHub API */
  let token = localStorage.getItem(GH_TOKEN_KEY);
  if (!token) {
    token = prompt(
      'Enter your GitHub Personal Access Token (PAT) to save this change for all users.\n\n' +
      'Scope required: "Contents write" for ' + GH_REPO + '\n\n' +
      'Leave empty to apply only on this device (not saved for others).'
    );
    if (!token || !token.trim()) return; /* user cancelled or skipped */
    token = token.trim();
    localStorage.setItem(GH_TOKEN_KEY, token);
  }

  const path = _GH_FILE_MAP[tab];
  if (!path) return;

  try {
    /* GET current file content + SHA for the PUT */
    const apiBase = 'https://api.github.com/repos/' + GH_OWNER + '/' + GH_REPO + '/contents/';
    const getResp = await fetch(apiBase + path + '?ref=' + GH_BRANCH, {
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.v3+json'
      }
    });

    if (getResp.status === 401 || getResp.status === 403) {
      localStorage.removeItem(GH_TOKEN_KEY);
      alert('GitHub token is invalid or lacks permission. Please re-enter your token next time.');
      return;
    }
    if (!getResp.ok) throw new Error('GitHub GET failed: ' + getResp.status);

    const fileData = await getResp.json();
    const sha      = fileData.sha;

    /* Decode → update → re-encode */
    const decoded  = new TextDecoder().decode(
      Uint8Array.from(atob(fileData.content.replace(/\n/g, '')), c => c.charCodeAt(0))
    );
    const jsonArr  = JSON.parse(decoded);
    const target   = jsonArr.find(m => m.monthKey === monthKey);
    if (target) target.published = newValue;
    const updated  = _toBase64(JSON.stringify(jsonArr, null, 2) + '\n');

    /* PUT updated file */
    const putResp = await fetch(apiBase + path, {
      method: 'PUT',
      headers: {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        message: (newValue ? 'Publish' : 'Unpublish') + ': ' + tab + ' ' + monthKey,
        content: updated,
        sha:     sha,
        branch:  GH_BRANCH
      })
    });

    if (putResp.status === 401 || putResp.status === 403) {
      localStorage.removeItem(GH_TOKEN_KEY);
      alert('GitHub token rejected. Please re-enter your token next time.');
      return;
    }
    if (!putResp.ok) {
      const errBody = await putResp.json().catch(() => ({}));
      throw new Error(errBody.message || 'GitHub PUT failed: ' + putResp.status);
    }
    /* Success — change will propagate to all users when GitHub Pages deploys */
  } catch (err) {
    /* Non-fatal: local state is already updated, just warn */
    console.warn('Publish toggle GitHub API error:', err.message);
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
    ? ' &nbsp;<span class="admin-note">(Admin view · edit via Git JSON)</span>'
    : '';
  return `<div class="archive-banner">🔒 Archived — read-only${roleNote}</div>`;
}

/* ══════════════════════════════════════════════════════════════════════════════
   PIN MODAL
   ══════════════════════════════════════════════════════════════════════════ */
let _pinCallback = null;

/** Show the PIN modal; onSuccess() called once correct PIN is entered */
function showPinModal(onSuccess) {
  _pinCallback = onSuccess;
  id('pin-modal').classList.remove('hidden');
  id('pin-input').value = '';
  id('pin-error').textContent = '';
  setTimeout(() => id('pin-input').focus(), 80);
}

/** Called by the modal Proceed button — async because we hash the input */
window.submitPin = async function submitPin() {
  const entered = id('pin-input').value.trim();
  if (!entered) return;
  let hash;
  try {
    hash = await sha256(entered);
  } catch (e) {
    id('pin-error').textContent = 'Verification error. Please try again.';
    return;
  }
  if (hash === ADMIN_HASH) {
    if (!tryAcquireAdminLock()) {
      id('pin-error').textContent = 'Admin is already logged in on another active session. Try again after that session closes.';
      id('pin-input').value = '';
      id('pin-input').focus();
      return;
    }
    accessRole = 'admin';
    /* Reset to first non-past (current) month on login */
    const _asi = state.sundayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_asi >= 0) state.sundayIdx = _asi;
    const _ati = state.tuesdayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_ati >= 0) state.tuesdayIdx = _ati;
    const _aspi = state.specialData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_aspi >= 0) state.specialIdx = _aspi;
    const _afi = state.fastingData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_afi >= 0) state.fastingIdx = _afi;
  } else if (hash === VIEWER_HASH) {
    accessRole = 'viewer';
    /* For viewer: default to first PUBLISHED non-past month */
    function _firstVisible(arr) {
      var i = arr.findIndex(function(m){ return !isPastMonth(m.monthKey) && m.published !== false; });
      if (i >= 0) return i;
      /* fallback: first published month at all */
      i = arr.findIndex(function(m){ return m.published !== false; });
      return i >= 0 ? i : 0;
    }
    state.sundayIdx  = _firstVisible(state.sundayData);
    state.tuesdayIdx = _firstVisible(state.tuesdayData);
    state.specialIdx = _firstVisible(state.specialData);
    state.fastingIdx = _firstVisible(state.fastingData);
  } else {
    id('pin-error').textContent = 'Incorrect PIN. Please try again.';
    id('pin-input').value = '';
    id('pin-input').focus();
    return;
  }
  syncAdminControls();
  id('pin-modal').classList.add('hidden');
  if (_pinCallback) { _pinCallback(); _pinCallback = null; }
};

/** Close modal without unlocking */
window.cancelPin = function cancelPin() {
  id('pin-modal').classList.add('hidden');
  _pinCallback = null;
  id('content').innerHTML = `
    <div style="text-align:center;padding:60px 24px;">
      <div style="font-size:48px;margin-bottom:16px;">🔒</div>
      <p style="font-size:16px;font-weight:600;color:#374151;margin-bottom:8px;">Schedule is locked</p>
      <p style="font-size:13px;color:#6b7280;margin-bottom:24px;">Enter your PIN to view the schedule.</p>
      <button class="pin-submit" style="max-width:200px;margin:0 auto;" onclick="showPinModal(() => render())">Enter PIN</button>
    </div>`;
};

/* ── Refresh app ────────────────────────────────────────────────── */
window.refreshApp = function refreshApp() {
  if (!accessRole) return; /* no PIN entered yet */
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
            var rs = rowspanVal[rowIdx][i] ? ' rowspan="' + rowspanVal[rowIdx][i] + '" style="vertical-align:middle;text-align:center;background:#eef2ff;font-style:italic;"' : '';
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
    + '<title>Peter Foundation &mdash; ' + htmlEsc(tabLabel) + ' &mdash; ' + htmlEsc(monthTitle) + '</title>'
    + '<style>'
    + 'body{font-family:Arial,Helvetica,sans-serif;margin:0;padding:20px;color:#111;background:#fff;}'
    + '.print-header{text-align:center;margin-bottom:24px;border-bottom:2px solid #333;padding-bottom:12px;}'
    + '.print-header h1{margin:0 0 4px;font-size:22px;}'
    + '.print-header h2{margin:0;font-size:16px;font-weight:normal;color:#555;}'
    + '.service-block{margin-bottom:28px;}'
    + '.service-block h3{font-size:15px;margin:0 0 8px;padding:6px 10px;background:#f3f4f6;border-left:4px solid #1a56db;}'
    + '.ev-date{margin:0 0 8px;font-size:13px;color:#666;}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px;}'
    + 'th,td{border:1px solid #ccc;padding:6px 8px;text-align:left;}'
    + 'th{background:#e5e7eb;font-weight:600;}'
    + '.role-col{min-width:120px;font-weight:600;background:#f9fafb;}'
    + '.sp-label{font-weight:600;width:130px;background:#f9fafb;}'
    + '.empty{color:#aaa;text-align:center;}'
    + '.footer{margin-top:32px;padding-top:12px;border-top:1px solid #ddd;font-size:11px;color:#999;text-align:center;}'
    + '@media print{'
    + '  body{padding:0;}'
    + '  .no-print{display:none!important;}'
    + '  .service-block{page-break-inside:avoid;}'
    + '}'
    + '</style></head><body>'
    + '<div class="print-header">'
    + '<h1>Peter Foundation</h1>'
    + '<h2>' + htmlEsc(tabLabel) + ' &mdash; ' + htmlEsc(monthTitle) + '</h2>'
    + '</div>'
    + '<button class="no-print" onclick="window.print()" style="display:block;margin:0 auto 24px;padding:10px 28px;font-size:15px;background:#1a56db;color:#fff;border:none;border-radius:8px;cursor:pointer;">&#128438; Print / Save as PDF</button>'
    + bodyHTML
    + '<div class="footer">Peter Foundation Event Details &mdash; printed '
    + new Date().toLocaleDateString('en-US', { year:'numeric', month:'long', day:'numeric' })
    + '</div>'
    + '</body></html>';

  var win = window.open('', '_blank');
  if (!win) {
    alert('Pop-up blocked. Please allow pop-ups for this site and try again.');
    return;
  }
  win.document.write(html);
  win.document.close();
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


/** Allow Enter key to submit PIN */
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !id('pin-modal').classList.contains('hidden')) {
    submitPin();
  }
  if (e.key === 'Escape' && !id('pin-modal').classList.contains('hidden')) {
    cancelPin();
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
