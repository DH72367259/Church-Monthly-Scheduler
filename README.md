# Peter Foundation Event Details

**Live app:** [https://dh72367259.github.io/Church-Monthly-Scheduler/](https://dh72367259.github.io/Church-Monthly-Scheduler/)

A **Progressive Web App (PWA)** for the Peter Foundation congregation. Displays the monthly Sunday service rota, Tuesday prayer assignments, and special day events. Fully works on **iOS (Safari)** and **Android (Chrome / any browser)** and can be pinned to the phone home screen as an icon — no App Store needed.

---

## Contents

1. [Features](#features)
2. [Access and PINs](#access-and-pins)
3. [Schedule Structure](#schedule-structure)
4. [Updating the Data](#updating-the-data)
5. [Adding a New Month](#adding-a-new-month)
6. [Changing a PIN](#changing-a-pin)
7. [Installing on Your Phone](#installing-on-your-phone)
8. [Technical Notes](#technical-notes)

---

## Features

| Feature | Description |
|---------|-------------|
| **PIN-protected** | Two roles: Viewer (current and future months) and Admin (all months + tools) |
| **Sunday Services** | Weekly rota for all three service locations with role-based columns per week |
| **Tuesday Prayer** | Weekly prayer assignments by slot, name, area, and pastor |
| **Special Days** | Good Friday, Easter, and other events with full program details |
| **Month navigation** | Viewer: current and future only. Admin: all months including archived |
| **Month picker** | Admin can jump to any month via a dropdown picker |
| **Download / Print** | Admin-only button — opens a clean printable page for the current tab and month |
| **Auto-refresh** | Silently checks for data updates in the background on every visit |
| **PWA / Offline** | Works offline via a service worker cache; auto-updates when online |
| **Home-screen icon** | Installable on iOS and Android — no App Store needed |

---

## Access and PINs

The app requires a PIN on every launch. There are two access levels:

| Role | Access | PIN |
|------|--------|-----|
| **Viewer** | Current and future months (read-only) | Contact your administrator |
| **Admin** | All months + Download/Print + Month picker | Contact your administrator |

> **Security note:** PINs are never stored in plain text. They are verified using SHA-256 hashing in the browser. Never share your PIN publicly.

---

## Schedule Structure

### Sunday Services

Three services run every Sunday:

| Time | Location |
|------|----------|
| 7:00 AM | Kachohally |
| 9:30 AM | Kachohally |
| 9:30 AM | Girigowdanadoddi |

Each service shows a table of program roles (Choir, Praise Worship, Sermon By, etc.) with actual Sunday dates as column headers.

### Tuesday Prayer

Lists prayer assignments for each Tuesday: slot number, name, area, and pastor.

### Special Days

Events such as Good Friday and Easter with full details: time, location, incharge, choir, praise worship, sermon, and more.

---

## Updating the Data

All schedule data is stored in plain JSON files inside the `data/` folder:

```
data/
  sunday-schedule.json     Sunday service rota (all three locations)
  tuesday-schedule.json    Tuesday prayer assignments
  special-schedule.json    Special day events
```

To update a role for a given week, open the relevant JSON file and edit the `weeks` array for that program entry. Index 0 is the first Sunday of the month, index 1 is the second Sunday, and so on.

Example — updating the Choir for the 2nd Sunday of April at 9:30 AM Kachohally:

```json
{
  "role": "Choir",
  "weeks": ["Group A", "Group B", "", ""]
}
```

After editing, commit and push to the `main` branch. The live app refreshes automatically within seconds once GitHub Pages deploys.

---

## Adding a New Month

1. Open the relevant JSON file (e.g., `data/sunday-schedule.json`).
2. Copy the last month object as a template.
3. Update `"month"` (e.g., `"June 2025"`) and `"monthKey"` (e.g., `"2025-06"`).
4. Clear all `weeks` values to empty strings `""`.
5. Commit and push.

The app picks up new months automatically — no code changes required.

---

## Changing a PIN

PINs are stored as SHA-256 hashes in `js/app.js`:

```js
const VIEWER_HASH = '...';   // SHA-256 hash of the viewer PIN
const ADMIN_HASH  = '...';   // SHA-256 hash of the admin PIN
```

To update a PIN:

1. Generate the SHA-256 hash of your new PIN (paste in any browser DevTools console):
   ```js
   crypto.subtle.digest('SHA-256', new TextEncoder().encode('YOUR_NEW_PIN'))
     .then(b => console.log([...new Uint8Array(b)].map(x => x.toString(16).padStart(2,'0')).join('')));
   ```
2. Replace the matching hash constant in `js/app.js`.
3. Commit and push.

---

## Installing on Your Phone

### iOS (Safari)

1. Open the app link in Safari.
2. Tap the **Share** icon (box with arrow pointing up).
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** — the icon appears on your home screen.

### Android (Chrome)

1. Open the app link in Chrome.
2. Tap the **three-dot menu** in the top right.
3. Tap **Add to Home Screen** or **Install App**.
4. Tap **Add** — the icon appears on your launcher.

---

## Technical Notes

- **Stack:** Vanilla HTML, CSS, and JavaScript — no frameworks, no npm, no build step.
- **Hosting:** GitHub Pages, auto-deployed from the `main` branch on every push.
- **Service Worker:** `sw.js` caches all app assets for offline use and posts an `SW_UPDATED` message to the page when a new version activates, triggering an automatic reload.
- **Data fetching:** JSON files are fetched with a cache-busting timestamp so admin data changes are seen immediately.
- **Admin Print / Download:** Tapping the download button (top-right, admin only) opens a self-contained printable HTML page in a new browser tab. On iOS: tap **Share → Print**. On Android: tap the browser menu → **Print** or **Save as PDF**.
- **No server required:** The entire app runs in the browser. All data is static JSON served from GitHub Pages.
