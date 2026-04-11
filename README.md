# Peter Foundation Event Details

Live app: https://dh72367259.github.io/Church-Monthly-Scheduler/

This build is PIN-only (OTP login removed).

## Login model

- Users login with phone number + PIN.
- Users can create/change their own PIN from the login modal.
- Admin can add users with phone number + role + PIN.
- Admin can view user PIN values in Manage Users.
- Maximum 3 active admins.

## Bootstrap admin

Configured in [js/firebase-config.js](js/firebase-config.js):

- Username: Admin
- Phone: 9738772736 (normalized to +919738772736)
- Initial PIN: 2603

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

## Testing

```bash
node --test tests/auth-utils.test.js
```

## Security note

This implementation follows your requested behavior (PIN-only + admin-visible PIN), but readable PIN storage is less secure than hash-only storage.
