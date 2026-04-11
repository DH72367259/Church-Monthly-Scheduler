/*
 * Firebase Configuration
 *
 * IMPORTANT: Replace placeholder values with your real Firebase Web App config.
 */

window.firebaseConfig = {
  apiKey: "YOUR_API_KEY_HERE",
  authDomain: "YOUR_AUTH_DOMAIN_HERE",
  projectId: "YOUR_PROJECT_ID_HERE",
  storageBucket: "YOUR_STORAGE_BUCKET_HERE",
  messagingSenderId: "YOUR_MESSAGING_SENDER_ID_HERE",
  appId: "YOUR_APP_ID_HERE"
};

/*
 * Bootstrap role-based phone numbers.
 * Keep at least one admin here so first admin can log in before Firestore users are managed from UI.
 */
window.authorizedPhoneNumbers = {
  "+911234567890": "viewer",
  "+919876543210": "admin"
};

(function initFirebaseOtp() {
  var cfg = window.firebaseConfig || {};
  var placeholders = [
    "YOUR_API_KEY_HERE",
    "YOUR_AUTH_DOMAIN_HERE",
    "YOUR_PROJECT_ID_HERE",
    "YOUR_STORAGE_BUCKET_HERE",
    "YOUR_MESSAGING_SENDER_ID_HERE",
    "YOUR_APP_ID_HERE"
  ];

  var values = [cfg.apiKey, cfg.authDomain, cfg.projectId, cfg.storageBucket, cfg.messagingSenderId, cfg.appId];
  var hasPlaceholders = values.some(function(v) { return !v || placeholders.indexOf(v) !== -1; });

  if (hasPlaceholders) {
    console.warn("Firebase config is not set. Update js/firebase-config.js with real credentials.");
    window.firebaseReady = false;
    return;
  }

  firebase.initializeApp(cfg);
  window.recaptchaVerifier = new firebase.auth.RecaptchaVerifier("recaptcha-container", {
    size: "invisible"
  });
  window.db = firebase.firestore();
  window.firebaseReady = true;
})();
