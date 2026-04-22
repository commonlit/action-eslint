const test = require('node:test');
const assert = require('node:assert/strict');
const { mapSeverity } = require('./oxlint-to-rdjsonl');

test('mapSeverity: error -> ERROR', () => {
  assert.equal(mapSeverity('error'), 'ERROR');
});

test('mapSeverity: warning -> WARNING', () => {
  assert.equal(mapSeverity('warning'), 'WARNING');
});

test('mapSeverity: advice -> INFO', () => {
  assert.equal(mapSeverity('advice'), 'INFO');
});

test('mapSeverity: unknown -> UNKNOWN_SEVERITY', () => {
  assert.equal(mapSeverity('bogus'), 'UNKNOWN_SEVERITY');
});
