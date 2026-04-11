const test = require('node:test');
const assert = require('node:assert/strict');

const authUtils = require('../js/auth-utils.js');

test('normalizePhoneNumber normalizes local Indian numbers', () => {
  assert.equal(authUtils.normalizePhoneNumber('9738772736', '91'), '+919738772736');
  assert.equal(authUtils.normalizePhoneNumber('+919738772736', '91'), '+919738772736');
});

test('normalizePhoneNumber rejects invalid values', () => {
  assert.equal(authUtils.normalizePhoneNumber('1234', '91'), null);
  assert.equal(authUtils.normalizePhoneNumber('', '91'), null);
});

test('validatePin accepts exactly 6 digits only', () => {
  assert.equal(authUtils.validatePin('2603'), false);
  assert.equal(authUtils.validatePin('123456'), true);
  assert.equal(authUtils.validatePin('1234567'), false);
  assert.equal(authUtils.validatePin('123'), false);
  assert.equal(authUtils.validatePin('12ab'), false);
});

test('sanitizeUsername trims and falls back safely', () => {
  assert.equal(authUtils.sanitizeUsername('  Admin User  ', 'User'), 'Admin User');
  assert.equal(authUtils.sanitizeUsername('', 'User'), 'User');
});

test('countActiveAdmins counts only active admins', () => {
  assert.equal(authUtils.countActiveAdmins([
    { role: 'admin', active: true },
    { role: 'viewer', active: true },
    { role: 'admin', active: false },
    { role: 'admin' }
  ]), 2);
});

test('hashPin is deterministic for the same phone and pin', async () => {
  const hash1 = await authUtils.hashPin('+919738772736', '2603');
  const hash2 = await authUtils.hashPin('+919738772736', '2603');
  const hash3 = await authUtils.hashPin('+919738772736', '9999');
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
});

test('safeEqual compares exact strings only', () => {
  assert.equal(authUtils.safeEqual('abc', 'abc'), true);
  assert.equal(authUtils.safeEqual('abc', 'abd'), false);
  assert.equal(authUtils.safeEqual('abc', 'ab'), false);
});