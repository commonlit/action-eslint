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

const { extractRuleCode } = require('./oxlint-to-rdjsonl');

test('extractRuleCode: plugin(rule) -> rule', () => {
  assert.equal(extractRuleCode('eslint(no-unused-vars)'), 'no-unused-vars');
});

test('extractRuleCode: nested parens preserved in rule', () => {
  assert.equal(extractRuleCode('typescript(no-empty-interface)'), 'no-empty-interface');
});

test('extractRuleCode: bare code passed through', () => {
  assert.equal(extractRuleCode('no-unused-vars'), 'no-unused-vars');
});

test('extractRuleCode: undefined -> undefined', () => {
  assert.equal(extractRuleCode(undefined), undefined);
});

test('extractRuleCode: empty string -> empty string', () => {
  assert.equal(extractRuleCode(''), '');
});

const { positionFromOffset } = require('./oxlint-to-rdjsonl');

test('positionFromOffset: offset 0 -> line 1, column 1', () => {
  const buf = Buffer.from('abc');
  assert.deepEqual(positionFromOffset(buf, 0), { line: 1, column: 1 });
});

test('positionFromOffset: middle of first line', () => {
  const buf = Buffer.from('abcdef');
  assert.deepEqual(positionFromOffset(buf, 3), { line: 1, column: 4 });
});

test('positionFromOffset: end-of-single-line buffer', () => {
  const buf = Buffer.from('abc');
  assert.deepEqual(positionFromOffset(buf, 3), { line: 1, column: 4 });
});
