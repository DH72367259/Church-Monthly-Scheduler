# Peter Foundation Event Details

Live app: https://dh72367259.github.io/Church-Monthly-Scheduler/

The app now supports:
- OTP login with Firebase Phone Authentication
- PIN unlock on browsers that already completed OTP registration for that phone
- Admin-managed users, roles, PINs, and month visibility in Firestore
- Maximum 3 active admins

## Bootstrap admin

The default bootstrap admin is already configured in [js/firebase-config.js](js/firebase-config.js):
- Username: `Admin`
- Phone: `9738772736` which is normalized as `+919738772736`
- Initial PIN: `2603`

Change that PIN later from the admin Manage Users screen.

Important security behavior:
- OTP is required the first time on each browser/device.
- PIN login works only after that browser already has a valid Firebase phone session for the same number.
- This keeps Firestore security active for both viewer and admin features.

## Firebase setup

### Enable phone auth

1. Open Firebase Console.
2. Create or select your project.
3. Go to Authentication, then Sign-in method.
4. Enable Phone.
5. Go to Authentication, then Settings, then Authorized domains.
6. Add `dh72367259.github.io` and `localhost`.

### Enable Firestore

1. Open Firestore Database.
2. Create the database in production mode.
3. Choose your region.

### Fill config values

Update the placeholders in [js/firebase-config.js](js/firebase-config.js) with your Firebase web app config.

## Firestore rules

Publish these rules in Firebase Console. They allow:
- admin users to manage users and month visibility
- a signed-in user to read their own user document
- the bootstrap admin number to create its first admin document
- a signed-in user to update only their own login metadata after OTP

```txt
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    function signedIn() {
      return request.auth != null;
    }

    function currentPhone() {
      return request.auth.token.phone_number;
    }

    function isOwnPhoneDoc(phone) {
      return signedIn() && currentPhone() == phone;
    }

    function isBootstrapAdmin(phone) {
      return signedIn() && phone == '+919738772736' && currentPhone() == '+919738772736';
    }

    function isAdmin() {
      return signedIn() &&
        exists(/databases/$(database)/documents/authorizedUsers/$(currentPhone())) &&
        get(/databases/$(database)/documents/authorizedUsers/$(currentPhone())).data.role == 'admin' &&
        get(/databases/$(database)/documents/authorizedUsers/$(currentPhone())).data.active != false;
    }

    function ownLoginMetadataOnly() {
      return request.resource.data.diff(resource.data).changedKeys().hasOnly([
        'lastLoginAt',
        'lastLoginMethod',
        'phoneVerifiedAt',
        'updatedAt'
      ]);
    }

    match /authorizedUsers/{phone} {
      allow read: if isOwnPhoneDoc(phone) || isAdmin();
      allow create: if isAdmin() || isBootstrapAdmin(phone);
      allow update: if isAdmin() || (isOwnPhoneDoc(phone) && ownLoginMetadataOnly());
      allow delete: if isAdmin();
    }

    match /monthVisibility/{docId} {
      allow read: if signedIn();
      allow create, update, delete: if isAdmin();
    }
  }
}
```

## How login works

### OTP login

1. Open the app.
2. Choose OTP.
3. Enter the phone number. `9738772736` is accepted and normalized to `+919738772736`.
4. Complete the SMS verification.
5. If the phone is authorized, the app opens and that browser is now registered for PIN unlock.

### PIN login

1. Open the app on a browser that already completed OTP once for the same phone.
2. Choose PIN.
3. Enter the PIN.
4. The app unlocks without another OTP.

On a new device or browser, PIN does not work until OTP registration is completed there first.

## Admin user management

From the admin users dialog the admin can:
- add viewer phones with PINs
- add admin phones with PINs
- edit usernames, roles, and PINs
- deactivate users

Rules enforced in the app:
- every user must have a phone number
- PIN must be 4 to 6 digits
- maximum 3 active admins
- current active admin cannot remove or downgrade their own session mid-login

## Month visibility

Admin can enable or disable month visibility directly from the month toggle. The change writes to Firestore immediately and shows up for signed-in users without any GitHub token flow.

## Testing

Unit tests for auth helpers are in [tests/auth-utils.test.js](tests/auth-utils.test.js).

Run them with:

```bash
node --test tests/auth-utils.test.js
```

## Notes

- Static JSON files still provide the schedule content.
- Firestore now stores user access, PIN metadata, and live visibility state.
- PIN is a convenience unlock on registered browsers. OTP remains the stronger recovery path and the required first-time registration step.
