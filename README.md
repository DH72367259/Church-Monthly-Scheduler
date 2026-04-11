# Peter Foundation Event Details

Live app: https://dh72367259.github.io/Church-Monthly-Scheduler/

This build is PIN-only (OTP login removed).

## Login model

- Users login with phone number + PIN.
- Initial PIN is set by admin. On first successful login, user must create a new PIN before app access.
- Users can change their own PIN after login.
- Admin can add users with phone number + role + PIN.
- Admin can view user PIN values in Manage Users.
- PIN must be exactly 6 digits.
- PIN cannot be first or last 6 digits of the phone number.
- PIN cannot be duplicated across users.
- Maximum 3 active admins.

## Bootstrap admin

Configured in [js/firebase-config.js](js/firebase-config.js):

- Username: Admin
- Phone: 9738772736 (normalized to +919738772736)
- Initial PIN: 260300 (must be changed after first login)

## Firebase setup

1. Create/select project in Firebase Console.
2. Enable Firestore Database.
3. Fill these values in [js/firebase-config.js](js/firebase-config.js):
   - apiKey
   - authDomain
   - projectId
   - storageBucket
   - messagingSenderId
   - appId

## Firestore rules

Rules file: [firestore.rules](firestore.rules)

If Firestore rejects reads/writes (for example because auth-based rules are still active), the app automatically falls back to local browser storage for:
- user registry
- PIN updates
- month visibility overrides

## Admin actions

From Manage Users:

- Add or edit viewer/admin accounts
- Set/reset PIN
- Remove users (deactivate)
- View PIN value per user
- Download a full schedule backup JSON
- Restore a backup JSON with merge-safe recovery of prior months and publish settings

## Schedule durability

- Schedule data is merged with stored backup snapshots on load so older months are not dropped by later code updates.
- Backup snapshots are kept in Firestore when available, with local browser storage as fallback.
- Admin can open Manage Users -> Backup & Restore to download a full backup before major edits or imports.
- Restore is merge-safe: imported months and visibility settings are added back without deleting current schedule data.

## Session behavior

- Viewer session is remembered for 2 days on that browser/home-screen app.
- Admin login is always required each time (no auto-resume).

## Testing

```bash
node --test tests/auth-utils.test.js
```

## Security note

This implementation follows your requested behavior (PIN-only + admin-visible PIN), but readable PIN storage is less secure than hash-only storage.
