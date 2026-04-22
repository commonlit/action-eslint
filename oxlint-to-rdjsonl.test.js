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

test('positionFromOffset: offset on a later line', () => {
  const buf = Buffer.from('abc\ndef');
  assert.deepEqual(positionFromOffset(buf, 4), { line: 2, column: 1 });
});

test('positionFromOffset: offset at newline is end of previous line', () => {
  const buf = Buffer.from('abc\ndef');
  assert.deepEqual(positionFromOffset(buf, 3), { line: 1, column: 4 });
});

test('positionFromOffset: across multiple newlines', () => {
  const buf = Buffer.from('a\nb\nc');
  assert.deepEqual(positionFromOffset(buf, 4), { line: 3, column: 1 });
});

test('positionFromOffset: offset past end clamps to buffer length', () => {
  const buf = Buffer.from('abc');
  assert.deepEqual(positionFromOffset(buf, 99), { line: 1, column: 4 });
});

test('positionFromOffset: UTF-8 multi-byte char — columns are byte positions', () => {
  const buf = Buffer.from('a🐶b');
  assert.equal(buf.length, 6);
  assert.deepEqual(positionFromOffset(buf, 5), { line: 1, column: 6 });
});

const { convertDiagnostic } = require('./oxlint-to-rdjsonl');

test('convertDiagnostic: full mapping of a typical diagnostic', () => {
  const diagnostic = {
    message: 'Unused variable',
    code: 'eslint(no-unused-vars)',
    severity: 'error',
    url: 'https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html',
    filename: 'src/foo.js',
    labels: [{ span: { offset: 4, length: 3 } }],
  };
  const fileReader = (path) => {
    assert.equal(path, 'src/foo.js');
    return Buffer.from('var abc = 1;');
  };
  const out = convertDiagnostic(diagnostic, fileReader);
  assert.deepEqual(out, {
    message: 'Unused variable',
    location: {
      path: 'src/foo.js',
      range: {
        start: { line: 1, column: 5 },
        end: { line: 1, column: 8 },
      },
    },
    severity: 'ERROR',
    code: {
      value: 'no-unused-vars',
      url: 'https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html',
    },
    source: { name: 'oxlint', url: 'https://oxc.rs/docs/guide/usage/linter.html' },
  });
});

test('convertDiagnostic: missing labels -> file-level, no range', () => {
  const out = convertDiagnostic(
    { message: 'hi', code: 'eslint(x)', severity: 'warning', filename: 'a.js', labels: [] },
    () => Buffer.from('')
  );
  assert.equal(out.location.path, 'a.js');
  assert.equal(out.location.range, undefined);
  assert.equal(out.severity, 'WARNING');
});

test('convertDiagnostic: missing filename -> no location', () => {
  const out = convertDiagnostic(
    { message: 'hi', severity: 'error' },
    () => { throw new Error('should not be called'); }
  );
  assert.equal(out.location, undefined);
});

test('convertDiagnostic: fileReader throws -> file-level, no range', () => {
  const out = convertDiagnostic(
    {
      message: 'hi',
      severity: 'error',
      filename: 'missing.js',
      labels: [{ span: { offset: 0, length: 1 } }],
    },
    () => { throw new Error('ENOENT'); }
  );
  assert.deepEqual(out.location, { path: 'missing.js' });
});

test('convertDiagnostic: missing url -> code without url field', () => {
  const out = convertDiagnostic(
    {
      message: 'hi',
      code: 'eslint(no-var)',
      severity: 'error',
      filename: 'a.js',
      labels: [{ span: { offset: 0, length: 1 } }],
    },
    () => Buffer.from('x')
  );
  assert.deepEqual(out.code, { value: 'no-var' });
});

test('convertDiagnostic: missing code -> no code field', () => {
  const out = convertDiagnostic(
    { message: 'hi', severity: 'error', filename: 'a.js', labels: [] },
    () => Buffer.from('')
  );
  assert.equal(out.code, undefined);
});

test('convertDiagnostic: multiple labels -> first label used', () => {
  const out = convertDiagnostic(
    {
      message: 'hi',
      code: 'eslint(x)',
      severity: 'error',
      filename: 'a.js',
      labels: [
        { span: { offset: 0, length: 1 } },
        { span: { offset: 5, length: 2 } },
      ],
    },
    () => Buffer.from('abcdefghij')
  );
  assert.deepEqual(out.location.range, {
    start: { line: 1, column: 1 },
    end: { line: 1, column: 2 },
  });
});

const { convert } = require('./oxlint-to-rdjsonl');

test('convert: empty array -> empty array', () => {
  assert.deepEqual(convert([], () => Buffer.from('')), []);
});

test('convert: maps each diagnostic and preserves order', () => {
  const diagnostics = [
    { message: 'a', code: 'p(r1)', severity: 'error', filename: 'f', labels: [] },
    { message: 'b', code: 'p(r2)', severity: 'warning', filename: 'f', labels: [] },
  ];
  const out = convert(diagnostics, () => Buffer.from(''));
  assert.equal(out.length, 2);
  assert.equal(out[0].message, 'a');
  assert.equal(out[0].severity, 'ERROR');
  assert.equal(out[1].message, 'b');
  assert.equal(out[1].severity, 'WARNING');
});

const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const CLI = path.join(__dirname, 'oxlint-to-rdjsonl.js');

function runCli(stdin, cwd = __dirname) {
  return spawnSync(process.execPath, [CLI], {
    input: stdin,
    cwd,
    encoding: 'utf8',
  });
}

test('cli: empty array -> exit 0, empty stdout', () => {
  const r = runCli('[]');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('cli: invalid JSON -> exit 1, stderr message', () => {
  const r = runCli('not json');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /invalid|parse/i);
});

test('cli: one diagnostic -> one rdjsonl line', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oxlint-cli-'));
  const fixture = path.join(tmp, 'x.js');
  fs.writeFileSync(fixture, 'var abc = 1;');
  const input = JSON.stringify([
    {
      message: 'Unused',
      code: 'eslint(no-unused-vars)',
      severity: 'error',
      url: 'https://oxc.rs/x',
      filename: fixture,
      labels: [{ span: { offset: 4, length: 3 } }],
    },
  ]);
  const r = runCli(input);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.message, 'Unused');
  assert.deepEqual(parsed.location.range.start, { line: 1, column: 5 });
  assert.equal(parsed.code.value, 'no-unused-vars');
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cli: real oxlint output shape ({ diagnostics: [...], ... }) is accepted', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oxlint-cli-'));
  const fixture = path.join(tmp, 'sample.js');
  fs.writeFileSync(fixture, 'var unusedVar = 1;\n');
  const input = JSON.stringify({
    diagnostics: [
      {
        message: "Variable 'unusedVar' is declared but never used.",
        code: 'eslint(no-unused-vars)',
        severity: 'warning',
        url: 'https://oxc.rs/docs/guide/usage/linter/rules/eslint/no-unused-vars.html',
        filename: fixture,
        labels: [{ span: { offset: 4, length: 9, line: 1, column: 5 } }],
      },
    ],
    number_of_files: 1,
    number_of_rules: 93,
    threads_count: 12,
    start_time: 0.01,
  });
  const r = runCli(input);
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.severity, 'WARNING');
  assert.deepEqual(parsed.location.range, {
    start: { line: 1, column: 5 },
    end: { line: 1, column: 14 },
  });
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('cli: garbage object (no diagnostics key) -> exit 1', () => {
  const r = runCli('{"foo": 1}');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /diagnostics/);
});

const { extractDiagnostics, makeCachingFileReader } = require('./oxlint-to-rdjsonl');

test('extractDiagnostics: bare array passes through', () => {
  assert.deepEqual(extractDiagnostics([{ a: 1 }]), [{ a: 1 }]);
});

test('extractDiagnostics: { diagnostics: [...] } unwraps', () => {
  assert.deepEqual(extractDiagnostics({ diagnostics: [{ a: 1 }], other: 2 }), [{ a: 1 }]);
});

test('extractDiagnostics: null for non-matching shapes', () => {
  assert.equal(extractDiagnostics({ foo: 1 }), null);
  assert.equal(extractDiagnostics(null), null);
  assert.equal(extractDiagnostics('string'), null);
});

test('makeCachingFileReader: reads each file once', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oxlint-cache-'));
  const p = path.join(tmp, 'x.js');
  fs.writeFileSync(p, 'abc');
  const reader = makeCachingFileReader();
  const first = reader(p);
  // Mutate the file on disk; cached read should not reflect the change.
  fs.writeFileSync(p, 'xyz');
  const second = reader(p);
  assert.equal(first.toString(), 'abc');
  assert.equal(second.toString(), 'abc');
  fs.rmSync(tmp, { recursive: true, force: true });
});
