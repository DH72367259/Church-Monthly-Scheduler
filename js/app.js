/* ─── Worship Library — Church Schedule App ─────────────────────────────── */
'use strict';

/* ══════════════════════════════════════════════════════════════════════════════
   ACCESS PINs — stored as SHA-256 hashes (never as plaintext).
   To change a PIN: compute sha256(newPin) and replace the hash below.
   VIEWER_HASH : congregation members — current month only.
   ADMIN_HASH  : admin — all months + Admin badge.
   ══════════════════════════════════════════════════════════════════════════ */
const VIEWER_HASH = '7599dc4548df450045cf9bc258c43c654ea6d4af04074eb0292262e3d5187d5b';
const ADMIN_HASH  = '120e90dfb21d132a40c6281f8c8f25331969559e200f589bfe8e775e333b5b3a';

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
  sundayIdx:    0,
  tuesdayIdx:   0,
  specialIdx:   0
};

/* ── Bootstrap ────────────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  registerSW();

  /* Re-fetch data silently whenever the user brings the app to the foreground */
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && accessRole) {
      refreshData();
    }
  });
});

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
}

/* ── Data loading ─────────────────────────────────────────────────────────── */
async function loadData() {
  const content = id('content');
  try {
    /* Cache-bust with a timestamp so admins' Git pushes are visible immediately */
    const ts = '?t=' + Date.now();
    const [sr, tr, xr] = await Promise.all([
      fetch('./data/sunday-schedule.json' + ts),
      fetch('./data/tuesday-prayer.json'  + ts),
      fetch('./data/special-days.json'    + ts)
    ]);
    if (!sr.ok) throw new Error('sunday-schedule.json not found');
    if (!tr.ok) throw new Error('tuesday-prayer.json not found');

    state.sundayData  = await sr.json();
    state.tuesdayData = await tr.json();

    /* Special days — gracefully optional */
    if (xr.ok) {
      state.specialData = await xr.json();
    }

    /* Default each tab to the first non-past month (current month), fall back to last */
    const _si = state.sundayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    state.sundayIdx  = _si  >= 0 ? _si  : Math.max(0, state.sundayData.length  - 1);
    const _ti = state.tuesdayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    state.tuesdayIdx = _ti  >= 0 ? _ti  : Math.max(0, state.tuesdayData.length - 1);

    /* Special Days: prefer first non-past month, then first with events, else last */
    const _spi = state.specialData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    const _firstWithEvents = state.specialData.findIndex(function(m){ return m.events && m.events.length > 0; });
    state.specialIdx = _spi >= 0 ? _spi : (_firstWithEvents >= 0 ? _firstWithEvents : Math.max(0, state.specialData.length - 1));

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
async function refreshData() {
  try {
    const ts = '?t=' + Date.now();
    const [sr, tr, xr] = await Promise.all([
      fetch('./data/sunday-schedule.json' + ts),
      fetch('./data/tuesday-prayer.json'  + ts),
      fetch('./data/special-days.json'    + ts)
    ]);
    if (!sr.ok || !tr.ok) return; /* silently skip on network error */
    const newSunday  = await sr.json();
    const newTuesday = await tr.json();
    const newSpecial = xr.ok ? await xr.json() : state.specialData;

    /* Only re-render if data actually changed */
    if (JSON.stringify(newSunday)  !== JSON.stringify(state.sundayData)  ||
        JSON.stringify(newTuesday) !== JSON.stringify(state.tuesdayData) ||
        JSON.stringify(newSpecial) !== JSON.stringify(state.specialData)) {
      state.sundayData  = newSunday;
      state.tuesdayData = newTuesday;
      state.specialData = newSpecial;
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
  /* Always reset to current month when switching tabs from the drawer */
  var arr  = tab === 'sunday'  ? state.sundayData
           : tab === 'tuesday' ? state.tuesdayData
           :                     state.specialData;
  var idxK = tab === 'sunday'  ? 'sundayIdx'
           : tab === 'tuesday' ? 'tuesdayIdx'
           :                     'specialIdx';
  var ci = arr.findIndex(function(m){ return !isPastMonth(m.monthKey); });
  if (ci >= 0) state[idxK] = ci;
  switchTab(tab);
};

/* Sync drawer highlight and header subtitle */
function updateDrawerState(tab) {
  const labels = { sunday: 'Sunday Services', tuesday: 'Tuesday Prayer', special: 'Special Days' };
  ['sunday','tuesday','special'].forEach(t => {
    id('drawer-' + t).classList.toggle('active', t === tab);
  });
  const label = id('header-tab-label');
  if (label) label.textContent = labels[tab] || '';
}

function refreshAllTabStates() {
  const now = new Date();
  const curKey = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0');

  const tuesdayBtn = id('drawer-tuesday');
  const specialBtn = id('drawer-special');

  if (accessRole === 'viewer') {
    const td = state.tuesdayData.find(function(m){ return m.monthKey === curKey; });
    const hasTuesday = !!(td && td.tuesdays && td.tuesdays.length > 0);
    if (tuesdayBtn) tuesdayBtn.classList.toggle('hidden-tab', !hasTuesday);

    const sd = state.specialData.find(function(m){ return m.monthKey === curKey; });
    const hasSpecial = !!(sd && sd.events && sd.events.length > 0);
    if (specialBtn) specialBtn.classList.toggle('hidden-tab', !hasSpecial);

    if (!hasTuesday && state.tab === 'tuesday') { state.tab = 'sunday'; }
    if (!hasSpecial  && state.tab === 'special')  { state.tab = 'sunday'; }
  } else {
    if (tuesdayBtn) tuesdayBtn.classList.remove('hidden-tab');
    if (specialBtn) specialBtn.classList.remove('hidden-tab');
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
  const arr  = tab === 'sunday'  ? state.sundayData
             : tab === 'tuesday' ? state.tuesdayData
             :                     state.specialData;
  const idxK = tab === 'sunday'  ? 'sundayIdx'
             : tab === 'tuesday' ? 'tuesdayIdx'
             :                     'specialIdx';
  const next = clamp(state[idxK] + dir, 0, arr.length - 1);
  /* Viewer: cannot navigate to strictly past months */
  if (accessRole === 'viewer' && isPastMonth(arr[next]?.monthKey)) return;
  /* Admin going backward into a past month: allow freely */

  state[idxK] = next;
  render();
};

/* ── Render dispatcher ────────────────────────────────────────────────────── */
function render() {
  updateDrawerState(state.tab);
  if      (state.tab === 'sunday')  renderSunday();
  else if (state.tab === 'tuesday') renderTuesday();
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
   HELPERS
   ══════════════════════════════════════════════════════════════════════════ */

/** Build month navigation bar HTML */
function monthNavHTML(idx, total, tab, monthName, monthKey) {
  const arr    = tab === 'sunday' ? state.sundayData
               : tab === 'tuesday' ? state.tuesdayData
               : state.specialData;
  const prevIdx = idx - 1;

  /* Viewer: prev button hidden only when previous month is in the past */
  const viewerMode = (accessRole === 'viewer');
  const prevIsArchived = prevIdx >= 0 && isPastMonth(arr[prevIdx]?.monthKey);
  const prevOff = (idx === 0 || prevIsArchived) ? 'disabled' : '';
  const nextOff = idx >= total - 1 ? 'disabled' : '';

  const archiveLock = (prevIsArchived && accessRole === 'admin') ? ' 🔒' : '';

  /* Access badge */
  let roleBadge = '';
  if (accessRole === 'admin')  roleBadge = '<span class="role-badge admin-badge">Admin</span>';
  if (accessRole === 'viewer') roleBadge = '<span class="role-badge viewer-badge">Viewer</span>';

  /* Hide prev button entirely for viewers when prev is a past month */
  const prevHidden = (viewerMode && prevIsArchived) ? 'style="display:none"' : '';

  var monthEl = accessRole === 'admin'
    ? '<button class="month-name-btn" onclick="showMonthPicker(\'' + tab + '\')" aria-label="Pick month">' + esc(monthName) + roleBadge + '<span class="picker-hint">&#9660;</span></button>'
    : '<span class="month-name">' + esc(monthName) + roleBadge + '</span>';

  return '<div class="month-nav">' +
    '<button class="nav-btn" onclick="navigateMonth(\'' + tab + '\',-1)" ' + prevOff + ' ' + prevHidden + ' aria-label="Previous month">&#8249;' + esc(archiveLock) + '</button>' +
    monthEl +
    '<button class="nav-btn" onclick="navigateMonth(\'' + tab + '\',1)" ' + nextOff + ' aria-label="Next month">&#8250;</button>' +
    '</div>';
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
    accessRole = 'admin';
    /* Reset to first non-past (current) month on login */
    const _asi = state.sundayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_asi >= 0) state.sundayIdx = _asi;
    const _ati = state.tuesdayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_ati >= 0) state.tuesdayIdx = _ati;
    const _aspi = state.specialData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_aspi >= 0) state.specialIdx = _aspi;
  } else if (hash === VIEWER_HASH) {
    accessRole = 'viewer';
    /* Reset to first non-past (current) month on login */
    const _si = state.sundayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_si >= 0) state.sundayIdx = _si;
    const _ti = state.tuesdayData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_ti >= 0) state.tuesdayIdx = _ti;
    const _spi = state.specialData.findIndex(function(m){ return !isPastMonth(m.monthKey); });
    if (_spi >= 0) state.specialIdx = _spi;
  } else {
    id('pin-error').textContent = 'Incorrect PIN. Please try again.';
    id('pin-input').value = '';
    id('pin-input').focus();
    return;
  }
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
window.refreshApp = async function refreshApp() {
  if (!accessRole) return; /* no PIN entered yet */
  var btn = id('refresh-btn');
  if (btn) btn.classList.add('spinning');
  await refreshData();
  if (btn) btn.classList.remove('spinning');
};

/* ── Admin month picker ───────────────────────────────────────────── */
var _pickerTab = null;

window.showMonthPicker = function showMonthPicker(tab) {
  if (accessRole !== 'admin') return;
  _pickerTab = tab;
  var arr  = tab === 'sunday'  ? state.sundayData
           : tab === 'tuesday' ? state.tuesdayData
           :                     state.specialData;
  var idxK = tab === 'sunday'  ? 'sundayIdx'
           : tab === 'tuesday' ? 'tuesdayIdx'
           :                     'specialIdx';
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
  var idxK = _pickerTab === 'sunday'  ? 'sundayIdx'
           : _pickerTab === 'tuesday' ? 'tuesdayIdx'
           :                            'specialIdx';
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
