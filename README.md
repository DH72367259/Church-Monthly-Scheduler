# Worship Library — Church Schedule

A **Progressive Web App (PWA)** for the church congregation. Displays the monthly Sunday service rota and Tuesday prayer assignments. Works on **iOS (Safari)** and **Android (Chrome / any browser)** and can be pinned to the phone's home screen as an icon — no App Store needed.

---

## Contents

- [Add to phone home screen](#add-to-phone-home-screen)
- [Features](#features)
- [Archive & PIN access](#archive--pin-access)
- [Deploy on GitHub Pages](#deploy-on-github-pages)
- [How admins update the schedule](#how-admins-update-the-schedule)
  - [Sunday Services](#datasunday-schedulejson)
  - [Tuesday Prayer](#datatuesday-prayerjson)
  - [Special Days](#dataspecial-daysjson)
- [Adding a new month](#adding-a-new-month)
- [Project structure](#project-structure)
- [Re-generating icons](#re-generating-icons)

---

## Add to phone home screen

### iOS — Safari
1. Open the app URL in **Safari** (must be Safari, not Chrome, for full PWA support on iOS).
2. Tap the **Share** button (box with upward arrow) at the bottom of the screen.
3. Scroll down and tap **"Add to Home Screen"**.
4. Tap **Add** — the Worship Library icon appears on your home screen.

### Android — Chrome
1. Open the URL in **Chrome**.
2. Tap the **three-dot menu ⋮** in the top-right corner.
3. Tap **"Add to Home Screen"** (some versions say **"Install App"**).
4. Tap **Add** — the icon appears on your home screen and opens full-screen like a native app.

> The app works **offline** after the first load — perfect for areas with weak signal.

---

## Features

| Tab | What it shows | When visible |
|-----|---------------|-------------|
| **Sunday Services** | Up to three services (7 AM · 9 AM · 9:30 AM). Each is a scrollable table — rows = roles (Incharge, Choir, Praise Worship, Sermon By, Translation, Preaching), columns = actual calendar dates for each Sunday of the month. | Always |
| **Tuesday Prayer** | One card per Tuesday. Each card lists up to 4 prayer-slot holders with their Name, Area, and Pastor to contact. | Always |
| **✦ Special Days** | A purple card for each special event (e.g. Good Friday, Easter, Christmas). Shows date, time, location, and full program details. | **Only when the admin has added at least one event** in `special-days.json`. The tab is greyed out and disabled when there is nothing to show. |

Other features:
- **Month navigation** (← →) to move between months.
- **Archive lock** — past months are automatically archived and PIN-protected (see below).
- **Optional notice banner** at the top of each month for extra announcements.
- Data is fetched fresh on every load — admin pushes a JSON change via Git and all users see it immediately.

---

## Archive & PIN access

Any month **before the current calendar month** is automatically marked as archived and read-only. Navigating backward into an archived month shows a PIN prompt.

| Role | PIN (defaults) | Access |
|------|---------------|--------|
| General members | *(no PIN)* | Current month and future months only |
| Trusted viewers | `1234` | All months including full archive — read-only |
| Admin | `9999` | All months + gold **Admin** badge + reminder to edit via Git |

**Rules:**
- Archived data is always **read-only** in the app. Nobody can edit schedules through the app — all changes go through the Git JSON files.
- The PIN session lasts until the browser tab is closed (`sessionStorage`). Users who close and reopen the app must re-enter their PIN to view archives.
- Admin and viewer PINs are stored only in `js/app.js` — change them there and push via Git to update for everyone.

### Changing the PINs

Open `js/app.js` and update the two lines at the very top:

```js
const VIEWER_PIN = '1234';   // ← trusted congregation members
const ADMIN_PIN  = '9999';   // ← admin
```

Commit and push. The new PINs take effect immediately for all users.

---

## Deploy on GitHub Pages

GitHub Pages is free and serves the app as a public HTTPS URL — required for PWA features (service worker, "Add to Home Screen").

```bash
# 1. Create a new public GitHub repository (e.g. "church-schedule")

# 2. Push this folder contents to the repo
git init
git add .
git commit -m "Initial church schedule PWA"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/church-schedule.git
git push -u origin main

# 3. Enable GitHub Pages
#    → GitHub repo → Settings → Pages
#    → Source: Deploy from branch → Branch: main → Folder: / (root)
#    → Save

# 4. Your app is live at:
#    https://YOUR-USERNAME.github.io/church-schedule/
```

Share that URL with the congregation. They bookmark it or add it to their home screen once — all future updates are instant.

---

## How admins update the schedule

All schedule data is in **two JSON files** inside the `data/` folder. Edit them directly on GitHub (click the file → pencil icon → edit → commit), or clone and push. Users see the update on their next app open.

### `data/sunday-schedule.json`

An array — one object per month. Add new months at the end; keep old ones so the archive works.

```json
{
  "month": "May 2026",
  "monthKey": "2026-05",
  "notes": "Optional notice — leave empty string if none.",
  "services": [
    {
      "time": "Sun 7:00 AM",
      "location": "Kachohally",
      "programs": [
        { "role": "Incharge",       "weeks": ["Name1", "Name2", "Name3", "Name4", ""] },
        { "role": "Choir",          "weeks": ["Name1", "Name2", "Name3", "Name4", ""] },
        { "role": "Praise Worship", "weeks": ["Name1", "Name2", "Name3", "Name4", ""] },
        { "role": "Sermon By",      "weeks": ["Name1", "Name2", "Name3", "Name4", ""] },
        { "role": "Translation",    "weeks": ["Name1", "Name2", "Name3", "Name4", ""] },
        { "role": "Preaching",      "weeks": ["Name1", "Name2", "Name3", "Name4", ""] }
      ]
    },
    {
      "time": "Sun 9:00 AM",
      "location": "Kachohally",
      "programs": [ "..." ]
    },
    {
      "time": "Sun 9:30 AM",
      "location": "Girigowdana",
      "programs": [ "..." ]
    }
  ]
}
```

**Field notes:**
- `monthKey` — `"YYYY-MM"` format. The app uses this to calculate the actual Sunday dates shown as column headers.
- `weeks` — up to 5 entries (one per Sunday). Use `""` for any Sunday not yet assigned.
- To add a new service location/time, add another object inside `services`.

### `data/tuesday-prayer.json`

An array — one object per month.

```json
{
  "month": "May 2026",
  "monthKey": "2026-05",
  "notes": "",
  "tuesdays": [
    {
      "date": "May 5, 2026",
      "slots": [
        { "name": "Person A", "area": "Kachohally",   "pastor": "Mohan" },
        { "name": "Person B", "area": "Girigowdana",  "pastor": "Anand" },
        { "name": "Person C", "area": "Whitefield",   "pastor": "Saravanan" },
        { "name": "Person D", "area": "Marathahalli", "pastor": "Jude" }
      ]
    }
  ]
}
```

**Field notes:**
- Each Tuesday supports **up to 4 slots**. Remove empty entries rather than leaving them blank.
- Add one `tuesdays` entry per Tuesday in the month.
- `pastor` is the contact pastor for that slot — shown in blue in the app.

### `data/special-days.json`

An array — one object per month. **The Special Days tab only becomes visible to users when at least one month has a non-empty `events` array.** If all months have `"events": []`, the tab stays greyed out and disabled.

```json
{
  "month": "April 2026",
  "monthKey": "2026-04",
  "events": [
    {
      "date": "April 3, 2026",
      "day": "Friday",
      "title": "Good Friday",
      "time": "7:00 AM",
      "location": "Kachohally",
      "incharge": "Mohan",
      "choir": "Darshan",
      "praiseWorship": "Anand",
      "sermonBy": "Pastor John",
      "translation": "Darshan",
      "preaching": "Pastor John",
      "notes": "Fasting prayer service. Please arrive early."
    },
    {
      "date": "April 5, 2026",
      "day": "Sunday",
      "title": "Easter Sunday",
      "time": "10:00 AM",
      "location": "Kachohally",
      "incharge": "Mohan",
      "choir": "Saravanan",
      "praiseWorship": "MUDIALBA",
      "preaching": "Pastor Mohan",
      "notes": "Special Easter celebration. All are welcome."
    }
  ]
}
```

**Field notes:**
- Only `date` and `title` are required. All other fields are optional — only filled fields appear in the card.
- Add as many events as needed inside one month's `events` array.
- To disable the tab for a month with no special days, set `"events": []`.
- Each month entry must still exist in the array (even with empty events) so month navigation works correctly.

**To add a special day for a new month**, append a new object to the array following the same structure.

---

## Adding a new month

1. Open each of the three JSON files on GitHub: `sunday-schedule.json`, `tuesday-prayer.json`, and `special-days.json`.
2. **Append** a new month object to the end of each array (copy the templates above).
3. Fill in names. Use `""` for any week not yet assigned.
4. For `special-days.json` — add events if there are any special services, otherwise set `"events": []`.
5. Commit and push. The new month is live immediately.

> Past months stay in the array permanently and become part of the archive. Users with the viewer or admin PIN can browse them.

---

## Project structure

```
church-schedule/
├── index.html                ← App shell (HTML structure + PIN modal)
├── manifest.json             ← PWA manifest (name, icons, theme colour)
├── sw.js                     ← Service worker (offline caching)
├── generate-icons.py         ← Run once to produce PNG icons (pure Python, no pip needed)
├── css/
│   └── style.css             ← All styles (layout, tables, modal, badges, special days)
├── js/
│   └── app.js                ← All app logic — tabs, month nav, PIN gate, rendering
├── data/
│   ├── sunday-schedule.json  ← ★ ADMIN EDITS THIS for Sunday services
│   ├── tuesday-prayer.json   ← ★ ADMIN EDITS THIS for Tuesday prayers
│   └── special-days.json     ← ★ ADMIN EDITS THIS for special days (Good Friday, Easter, etc.)
└── icons/
    ├── icon.svg              ← Vector source icon
    ├── icon-192.png          ← PWA manifest icon (Android)
    ├── icon-512.png          ← PWA manifest icon large (Android)
    └── apple-touch-icon.png  ← iOS "Add to Home Screen" icon (180×180)
```

No build step. No npm. No frameworks. Plain HTML + CSS + JavaScript.

---

## Re-generating icons

Run after any changes to `generate-icons.py`:

```bash
python3 generate-icons.py
```

Uses only Python built-ins (`struct`, `zlib`) — no Pillow or other packages needed.
