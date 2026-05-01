const test = require('node:test');
const assert = require('node:assert/strict');

const { getSessionAuthStatus } = require('../dist/auth.js');

test('static bearer sessions report as authorized', () => {
  assert.equal(getSessionAuthStatus('static'), 'authorized');
});

test('schedule bearer sessions report as authorized', () => {
  assert.equal(getSessionAuthStatus('schedule:user@example.com'), 'authorized');
});
