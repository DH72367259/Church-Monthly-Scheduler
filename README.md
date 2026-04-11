# Peter Foundation Event Details

Live app: https://dh72367259.github.io/Church-Monthly-Scheduler/

The app now uses:
- Firebase Phone OTP for login
- Firestore for user access management
- Firestore for month/tab visibility toggles
- No GitHub token prompt for publish/unpublish

## What changed

Admin can now do these directly from the app UI:
- add viewer phone numbers
- add admin phone numbers
- remove users
- change a month/tab visibility using the toggle

These changes update through Firestore immediately for all users using the app.

## 1. Firebase setup

### A. Enable Phone OTP

1. Open Firebase Console.
2. Create/select project.
3. Go to Authentication -> Sign-in method.
4. Enable Phone.
5. Go to Authentication -> Settings -> Authorized domains.
6. Add:
   - dh72367259.github.io
   - localhost

### B. Enable Firestore

1. Firebase Console -> Firestore Database.
2. Click Create database.
3. Start in production mode.
4. Choose your region.
5. Create database.

## 2. Update js/firebase-config.js

Open js/firebase-config.js and fill your real Firebase Web App config:
- apiKey
- authDomain
- projectId
- storageBucket
- messagingSenderId
- appId

Important:
- Keep at least one admin number in window.authorizedPhoneNumbers initially.
- That bootstrap admin is needed for the first admin login.
- After first login, admin can manage users from UI and you do not need to keep editing the file for every user.

Example bootstrap block:
- "+919876543210": "admin"

## 3. Firestore security rules

In Firebase Console -> Firestore Database -> Rules, paste this and publish:

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    function isOwnPhoneDoc(phone) {
      return signedIn() && request.auth.token.phone_number == phone;
    }

    function isAdmin() {
      return signedIn() &&
        exists(/databases/$(database)/documents/authorizedUsers/$(request.auth.token.phone_number)) &&
        get(/databases/$(database)/documents/authorizedUsers/$(request.auth.token.phone_number)).data.role == 'admin' &&
        get(/databases/$(database)/documents/authorizedUsers/$(request.auth.token.phone_number)).data.active != false;
    }

    match /authorizedUsers/{phone} {
      allow read: if isOwnPhoneDoc(phone) || isAdmin();
      allow create, update, delete: if isAdmin();
    }

    match /monthVisibility/{docId} {
      allow read: if signedIn();
      allow create, update, delete: if isAdmin();
    }
  }
}
```

This gives:
- admin can manage users and visibility
- signed-in users can read visibility
- a user can read their own role doc

## 4. Deploy

1. Save changes.
2. Commit and push to main.
3. Wait for GitHub Pages deploy.
4. Open the app once and refresh.

## 5. Exact UI steps to use it

### First admin login

1. Open the app.
2. OTP popup appears.
3. Enter the bootstrap admin phone number from js/firebase-config.js.
4. Tap Send OTP.
5. Enter the 6-digit code.
6. Tap Verify OTP.
7. You enter admin mode.

### Add viewer/admin users from UI

1. Login as admin.
2. In the top header, tap the users icon.
3. Manage Users popup opens.
4. Enter phone number in format +countrycodephonenumber.
5. Choose role:
   - viewer
   - admin
6. Tap Save User.
7. That user can now log in with OTP.

### Remove user from UI

1. Login as admin.
2. Tap the users icon.
3. In the users list, tap Remove.
4. That phone number loses access.

### Viewer login

1. Open app.
2. Enter allowed viewer phone number.
3. Tap Send OTP.
4. Enter SMS OTP.
5. Tap Verify OTP.
6. Viewer gets access automatically.

There is no 7242 PIN flow anymore when Firestore OTP setup is active.

## 6. Exact UI steps for enabling/disabling months immediately

1. Login as admin.
2. Open any tab:
   - Sunday
   - Tuesday
   - Special
   - Fasting
3. Go to the month.
4. Use the toggle below the month header:
   - ON = visible to users
   - OFF = hidden from users
5. That change writes to Firestore immediately.
6. Other signed-in users see it after live refresh / app refresh without any GitHub token.

## 7. Notes on live behavior

- Month visibility no longer depends on GitHub PAT.
- User access no longer requires editing files for each new user.
- Firestore is now the live source for:
  - authorized users
  - published month visibility
- Static JSON still remains the source for schedule content itself.

## 8. Troubleshooting

### OTP says not authorized
- Phone number was not added in Manage Users.
- Or the bootstrap admin/viewer number in js/firebase-config.js is wrong.

### Toggle does not save
- Firestore is not enabled.
- Firestore rules were not published.
- Firebase config values are still placeholders.

### Users icon does not show
- You are not logged in as admin.
- The phone number is not stored as role admin.

### First admin cannot log in
- Put that admin phone in window.authorizedPhoneNumbers inside js/firebase-config.js.
- Push and refresh once.

## 9. Recommended next improvement

If you want, next I can move the schedule content itself from JSON to Firestore too. Then admin could edit service assignments directly from the UI, not just users and visibility.
