(function(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.authUtils = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';

  var PIN_ITERATIONS = 150000;
  var KEY_LENGTH_BITS = 256;

  function normalizePhoneNumber(input, defaultCountryCode) {
    if (!input) return null;
    var raw = String(input).trim();
    var digits = raw.replace(/\D/g, '');
    var country = String(defaultCountryCode || '91').replace(/\D/g, '');

    if (raw.charAt(0) === '+') {
      return /^\+\d{10,15}$/.test(raw) ? ('+' + digits) : null;
    }
    if (digits.length === 10) {
      return '+' + country + digits;
    }
    if (digits.length >= 11 && digits.length <= 15) {
      return '+' + digits;
    }
    return null;
  }

  function sanitizeUsername(name, fallback) {
    var safe = String(name || '').trim().replace(/\s+/g, ' ');
    if (!safe) return fallback || 'User';
    return safe.slice(0, 32);
  }

  function validatePin(pin) {
    return /^\d{6}$/.test(String(pin || '').trim());
  }

  function countActiveAdmins(users) {
    return (users || []).filter(function(user) {
      return user && user.active !== false && user.role === 'admin';
    }).length;
  }

  async function hashPin(phoneNumber, pin) {
    if (!globalThis.crypto || !globalThis.crypto.subtle) {
      throw new Error('Web Crypto API is not available.');
    }

    var encoder = new TextEncoder();
    var key = await globalThis.crypto.subtle.importKey(
      'raw',
      encoder.encode(String(pin || '').trim()),
      { name: 'PBKDF2' },
      false,
      ['deriveBits']
    );
    var bits = await globalThis.crypto.subtle.deriveBits({
      name: 'PBKDF2',
      salt: encoder.encode('pf-login|' + String(phoneNumber || '').trim()),
      iterations: PIN_ITERATIONS,
      hash: 'SHA-256'
    }, key, KEY_LENGTH_BITS);

    return Array.from(new Uint8Array(bits)).map(function(byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function safeEqual(a, b) {
    var left = String(a || '');
    var right = String(b || '');
    if (left.length !== right.length) return false;
    var diff = 0;
    for (var i = 0; i < left.length; i++) {
      diff |= left.charCodeAt(i) ^ right.charCodeAt(i);
    }
    return diff === 0;
  }

  function pinLoginAvailable(profile, sessionPhone) {
    return !!(
      profile &&
      profile.active !== false &&
      profile.pinHash &&
      sessionPhone &&
      normalizePhoneNumber(profile.phone || sessionPhone, '91') === normalizePhoneNumber(sessionPhone, '91')
    );
  }

  return {
    PIN_ITERATIONS: PIN_ITERATIONS,
    normalizePhoneNumber: normalizePhoneNumber,
    sanitizeUsername: sanitizeUsername,
    validatePin: validatePin,
    countActiveAdmins: countActiveAdmins,
    hashPin: hashPin,
    safeEqual: safeEqual,
    pinLoginAvailable: pinLoginAvailable
  };
});