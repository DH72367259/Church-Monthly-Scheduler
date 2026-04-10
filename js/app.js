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
});

function registerSW() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(() => {/* silent */});
  }
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

    /* Default each tab to its latest month */
    state.sundayIdx  = Math.max(0, state.sundayData.length  - 1);
    state.tuesdayIdx = Math.max(0, state.tuesdayData.length - 1);

    /* Special Days tab: default to the first month that has events, else last month */
    const firstWithEvents = state.specialData.findIndex(m => m.events && m.events.length > 0);
    state.specialIdx = firstWithEvents >= 0 ? firstWithEvents : Math.max(0, state.specialData.length - 1);

    /* Enable/disable the Special Days tab based on whether ANY events exist */
    refreshSpecialTabState();

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

/**
 * Enable the Special Days tab if ANY month has at least one event.
 * Disable and grey it out otherwise.
 */
function refreshSpecialTabState() {
  const btn      = id('tab-special');
  if (!btn) return;
  const hasAny   = state.specialData.some(m => m.events && m.events.length > 0);
  btn.classList.toggle('disabled', !hasAny);
  btn.setAttribute('aria-disabled', String(!hasAny));
}

/* ── Tab switching ────────────────────────────────────────────────────────── */
window.switchTab = function switchTab(tab) {
  /* Block clicks on disabled Special Days tab */
  if (tab === 'special') {
    const btn = id('tab-special');
    if (btn && btn.classList.contains('disabled')) return;
  }
  state.tab = tab;
  document.querySelectorAll('.tab-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
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

  /* Going backward into an archived (past) month — only admin may view */
  if (dir < 0 && isPastMonth(arr[next]?.monthKey) && accessRole !== 'admin') {
    showPinModal(() => { state[idxK] = next; render(); });
    return;
  }

  state[idxK] = next;
  render();
};

/* ── Render dispatcher ────────────────────────────────────────────────────── */
function render() {
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
    content.innerHTML = emptyState('No Tuesday prayer data available.');
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
    html += emptyState('No Tuesday prayers scheduled for this month.');
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
      <p>No special days added for ${esc(data.month)}.<br>
         The admin can add events to the JSON file.</p>
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
  const prevOff = idx === 0        ? 'disabled' : '';
  const nextOff = idx >= total - 1 ? 'disabled' : '';
  const arr     = tab === 'sunday' ? state.sundayData : state.tuesdayData;

  /* Lock icon on Previous button when the preceding month is archived & user is not admin */
  const prevIdx  = idx - 1;
  const prevIsArchived = prevIdx >= 0 && isPastMonth(arr[prevIdx]?.monthKey) && accessRole !== 'admin';
  const archiveLock = prevIsArchived ? ' 🔒' : '';

  /* Access badge shown in the nav bar when a role is active */
  let roleBadge = '';
  if (accessRole === 'admin')  roleBadge = '<span class="role-badge admin-badge">Admin</span>';
  if (accessRole === 'viewer') roleBadge = '<span class="role-badge viewer-badge">Viewer</span>';

  return `
    <div class="month-nav">
      <button class="nav-btn" onclick="navigateMonth('${tab}',-1)"
              ${prevOff} aria-label="Previous month" title="${prevIsArchived ? 'Archive — PIN required' : 'Previous month'}">&#8249;${esc(archiveLock)}</button>
      <span class="month-name">${esc(monthName)}${roleBadge}</span>
      <button class="nav-btn" onclick="navigateMonth('${tab}',1)"
              ${nextOff} aria-label="Next month">&#8250;</button>
    </div>`;
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
  } else if (hash === VIEWER_HASH) {
    accessRole = 'viewer';
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
