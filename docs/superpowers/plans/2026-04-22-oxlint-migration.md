# Oxlint Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose this composite GitHub Action to run [oxlint](https://oxc.rs/docs/guide/usage/linter.html) through reviewdog instead of eslint. Breaking change; no backward-compat shim.

**Architecture:** The action is a composite action. `action.yml` declares inputs and forwards them as `INPUT_*` env vars to `script.sh`, which installs reviewdog, runs `oxlint --format=json`, pipes the output through a new Node-based converter (`oxlint-to-rdjsonl.js`), then into `reviewdog -f=rdjsonl`. The converter is the only genuinely new code; everything else is renames, edits, and deletions.

**Tech Stack:** Bash (`script.sh`), GitHub composite action YAML, Node.js (converter + tests, using `node:test` — no devDeps), oxlint (consumer-installed).

**Spec:** `docs/superpowers/specs/2026-04-21-oxlint-migration-design.md`.

---

## File Structure

**Created:**
- `oxlint-to-rdjsonl.js` — pure-function module + CLI entrypoint. Exports `mapSeverity`, `extractRuleCode`, `positionFromOffset`, `convertDiagnostic`, `convert`, `main`. If invoked directly (`node oxlint-to-rdjsonl.js`), reads JSON from stdin, writes rdjsonl to stdout.
- `oxlint-to-rdjsonl.test.js` — uses Node's built-in `node:test` runner; imports the above module and tests each pure function plus one end-to-end test that spawns the CLI.
- `.oxlintrc.json` — repo-root oxlint config pinning rules so test-fixture output is deterministic.
- `testdata/converter/simple.js`, `testdata/converter/multiline.js`, `testdata/converter/utf8.js` — fixtures for converter unit tests (NOT linted by oxlint; they're just text files read by the converter during tests).

**Modified:**
- `action.yml` — input renames, removals, metadata rewrite.
- `script.sh` — eslint→oxlint invocation; drop custom formatter path; pipe through converter.
- `README.md` — full rewrite for oxlint.
- `testdata/test.js`, `testdata/error.js`, `testdata/empty.js` — tweak to fire oxlint rules deterministically.
- `test-subproject/package.json` — swap eslint family for `oxlint` devDep; regenerate lockfile.
- `test-subproject/sub-testdata/*.js` — same deterministic tweaks.
- `.github/workflows/test.yml` — run `node --test` on the converter instead of the old formatter's shell test.
- `.github/workflows/reviewdog.yml` — rename `eslint_flags` → `oxlint_flags`, rename `tool_name` values, install `oxlint` before invoking the action.

**Deleted:**
- `eslint-formatter-rdjson/` (entire directory, including `index.js`, `package.json`, tests, testdata).
- `.eslintrc.js` at repo root.
- `package.json` and `package-lock.json` at repo root.
- `test-subproject/.eslintrc.js`.
- `.github/workflows/npm-publish.yml` — publishes `eslint-formatter-rdjson` to npm; the new action has no npm package to publish.

**Unchanged:**
- `.github/workflows/depup.yml`, `.github/workflows/release.yml` — version-bumping infrastructure operates on `action.yml`'s `REVIEWDOG_VERSION` and git tags; agnostic to what the action does.
- `.gitignore`, `LICENSE`.

---

## Task 1: Scaffold converter module with severity-mapping test

**Files:**
- Create: `oxlint-to-rdjsonl.js`
- Create: `oxlint-to-rdjsonl.test.js`

- [ ] **Step 1.1: Write the failing test**

Create `oxlint-to-rdjsonl.test.js` with:

```js
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
```

- [ ] **Step 1.2: Run test to verify it fails**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: FAIL — `Cannot find module './oxlint-to-rdjsonl'`.

- [ ] **Step 1.3: Write minimal implementation**

Create `oxlint-to-rdjsonl.js`:

```js
'use strict';

function mapSeverity(s) {
  if (s === 'error') return 'ERROR';
  if (s === 'warning') return 'WARNING';
  if (s === 'advice') return 'INFO';
  return 'UNKNOWN_SEVERITY';
}

module.exports = { mapSeverity };
```

- [ ] **Step 1.4: Run test to verify it passes**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — all four subtests pass.

- [ ] **Step 1.5: Commit**

```bash
git add oxlint-to-rdjsonl.js oxlint-to-rdjsonl.test.js
git commit -m "feat(converter): scaffold module with severity mapping"
```

---

## Task 2: Rule code extraction

**Files:**
- Modify: `oxlint-to-rdjsonl.test.js` (append)
- Modify: `oxlint-to-rdjsonl.js`

- [ ] **Step 2.1: Append failing tests**

Append to `oxlint-to-rdjsonl.test.js`:

```js
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
```

- [ ] **Step 2.2: Run test to verify it fails**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: FAIL — `extractRuleCode is not a function`.

- [ ] **Step 2.3: Implement**

Add to `oxlint-to-rdjsonl.js`:

```js
function extractRuleCode(code) {
  if (code === undefined || code === null) return undefined;
  const match = /^[^(]+\(([^)]+)\)$/.exec(code);
  return match ? match[1] : code;
}
```

And update `module.exports`:

```js
module.exports = { mapSeverity, extractRuleCode };
```

- [ ] **Step 2.4: Run test to verify it passes**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — all subtests from Tasks 1 and 2 pass.

- [ ] **Step 2.5: Commit**

```bash
git add oxlint-to-rdjsonl.js oxlint-to-rdjsonl.test.js
git commit -m "feat(converter): extract rule code from plugin(rule) format"
```

---

## Task 3: Byte-offset → line/column — single line

**Files:**
- Modify: `oxlint-to-rdjsonl.test.js`
- Modify: `oxlint-to-rdjsonl.js`

- [ ] **Step 3.1: Append failing tests**

Append to `oxlint-to-rdjsonl.test.js`:

```js
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
```

- [ ] **Step 3.2: Run test to verify it fails**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: FAIL — `positionFromOffset is not a function`.

- [ ] **Step 3.3: Implement**

Add to `oxlint-to-rdjsonl.js`:

```js
// Convert a UTF-8 byte offset into {line, column}, both 1-based.
// column is 1-based UTF-8 byte position within its line (what reviewdog expects).
function positionFromOffset(buffer, offset) {
  let line = 1;
  let column = 1;
  const end = Math.min(offset, buffer.length);
  for (let i = 0; i < end; i++) {
    if (buffer[i] === 0x0A) {
      line++;
      column = 1;
    } else {
      column++;
    }
  }
  return { line, column };
}
```

Update `module.exports`:

```js
module.exports = { mapSeverity, extractRuleCode, positionFromOffset };
```

- [ ] **Step 3.4: Run test to verify it passes**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — all tests from Tasks 1–3.

- [ ] **Step 3.5: Commit**

```bash
git add oxlint-to-rdjsonl.js oxlint-to-rdjsonl.test.js
git commit -m "feat(converter): byte-offset to line/column for single-line input"
```

---

## Task 4: Byte-offset → line/column — multi-line and boundaries

**Files:**
- Modify: `oxlint-to-rdjsonl.test.js`

- [ ] **Step 4.1: Append failing tests**

Append to `oxlint-to-rdjsonl.test.js`:

```js
test('positionFromOffset: offset on a later line', () => {
  // "abc\ndef" — offset 4 is 'd' on line 2
  const buf = Buffer.from('abc\ndef');
  assert.deepEqual(positionFromOffset(buf, 4), { line: 2, column: 1 });
});

test('positionFromOffset: offset at newline is end of previous line', () => {
  // "abc\ndef" — offset 3 is the '\n' byte itself; column counts it as end-of-line 1
  const buf = Buffer.from('abc\ndef');
  assert.deepEqual(positionFromOffset(buf, 3), { line: 1, column: 4 });
});

test('positionFromOffset: across multiple newlines', () => {
  const buf = Buffer.from('a\nb\nc');
  // offset 4 = 'c' on line 3, column 1
  assert.deepEqual(positionFromOffset(buf, 4), { line: 3, column: 1 });
});

test('positionFromOffset: offset past end clamps to buffer length', () => {
  const buf = Buffer.from('abc');
  assert.deepEqual(positionFromOffset(buf, 99), { line: 1, column: 4 });
});

test('positionFromOffset: UTF-8 multi-byte char — columns are byte positions', () => {
  // '🐶' is 4 UTF-8 bytes (F0 9F 90 B6). Source: "a🐶b"
  const buf = Buffer.from('a🐶b');
  assert.equal(buf.length, 6);
  // offset 5 is 'b' — column 6 (1-based bytes)
  assert.deepEqual(positionFromOffset(buf, 5), { line: 1, column: 6 });
});
```

- [ ] **Step 4.2: Run test**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — the implementation from Task 3 already handles all of these. These tests are regression coverage; if any fail, the implementation must be fixed to make them pass before committing.

- [ ] **Step 4.3: Commit**

```bash
git add oxlint-to-rdjsonl.test.js
git commit -m "test(converter): cover multi-line, boundary, and UTF-8 offset cases"
```

---

## Task 5: `convertDiagnostic` for a well-formed input

**Files:**
- Modify: `oxlint-to-rdjsonl.test.js`
- Modify: `oxlint-to-rdjsonl.js`

- [ ] **Step 5.1: Append failing test**

Append to `oxlint-to-rdjsonl.test.js`:

```js
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
  // source file: "var abc = 1;"
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
```

- [ ] **Step 5.2: Run test to verify it fails**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: FAIL — `convertDiagnostic is not a function`.

- [ ] **Step 5.3: Implement**

Add to `oxlint-to-rdjsonl.js`:

```js
const OXLINT_SOURCE = {
  name: 'oxlint',
  url: 'https://oxc.rs/docs/guide/usage/linter.html',
};

function convertDiagnostic(diagnostic, fileReader) {
  const out = {
    message: diagnostic.message,
    severity: mapSeverity(diagnostic.severity),
    source: OXLINT_SOURCE,
  };

  const ruleValue = extractRuleCode(diagnostic.code);
  if (ruleValue !== undefined) {
    out.code = { value: ruleValue };
    if (diagnostic.url) out.code.url = diagnostic.url;
  }

  const filename = diagnostic.filename;
  if (filename) {
    const location = { path: filename };
    const label = (diagnostic.labels || [])[0];
    if (label && label.span) {
      let buffer = null;
      try {
        buffer = fileReader(filename);
      } catch (_err) {
        buffer = null;
      }
      if (buffer) {
        const start = positionFromOffset(buffer, label.span.offset);
        const end = positionFromOffset(buffer, label.span.offset + label.span.length);
        location.range = { start, end };
      }
    }
    out.location = location;
  }

  return out;
}

module.exports = { mapSeverity, extractRuleCode, positionFromOffset, convertDiagnostic };
```

- [ ] **Step 5.4: Run test to verify it passes**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — all tests from Tasks 1–5.

- [ ] **Step 5.5: Commit**

```bash
git add oxlint-to-rdjsonl.js oxlint-to-rdjsonl.test.js
git commit -m "feat(converter): transform one oxlint diagnostic to rdjsonl"
```

---

## Task 6: `convertDiagnostic` edge cases — no labels, no filename, read failure, URL missing, multiple labels

**Files:**
- Modify: `oxlint-to-rdjsonl.test.js`

- [ ] **Step 6.1: Append failing tests**

Append to `oxlint-to-rdjsonl.test.js`:

```js
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
```

- [ ] **Step 6.2: Run test**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — the implementation from Task 5 already handles these cases (thanks to the `try/catch`, `label &&` guard, etc.). If any case fails, fix the implementation before committing.

- [ ] **Step 6.3: Commit**

```bash
git add oxlint-to-rdjsonl.test.js
git commit -m "test(converter): edge cases for convertDiagnostic"
```

---

## Task 7: `convert` array-level function

**Files:**
- Modify: `oxlint-to-rdjsonl.test.js`
- Modify: `oxlint-to-rdjsonl.js`

- [ ] **Step 7.1: Append failing test**

Append to `oxlint-to-rdjsonl.test.js`:

```js
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
```

- [ ] **Step 7.2: Run test to verify it fails**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: FAIL — `convert is not a function`.

- [ ] **Step 7.3: Implement**

Add to `oxlint-to-rdjsonl.js`:

```js
function convert(diagnostics, fileReader) {
  return diagnostics.map((d) => convertDiagnostic(d, fileReader));
}
```

Update `module.exports`:

```js
module.exports = {
  mapSeverity,
  extractRuleCode,
  positionFromOffset,
  convertDiagnostic,
  convert,
};
```

- [ ] **Step 7.4: Run test to verify it passes**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS.

- [ ] **Step 7.5: Commit**

```bash
git add oxlint-to-rdjsonl.js oxlint-to-rdjsonl.test.js
git commit -m "feat(converter): convert a list of diagnostics"
```

---

## Task 8: CLI entrypoint — stdin/stdout, exit codes, invalid JSON

**Files:**
- Modify: `oxlint-to-rdjsonl.js`
- Modify: `oxlint-to-rdjsonl.test.js`

- [ ] **Step 8.1: Append failing test**

Append to `oxlint-to-rdjsonl.test.js`:

```js
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
  // Stage a fixture file that will be read via the diagnostic's filename.
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
```

- [ ] **Step 8.2: Run test to verify it fails**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: FAIL — the CLI entrypoint does not yet exist, so running the file as a process produces no output (the current file only exports functions).

- [ ] **Step 8.3: Implement CLI**

Append to `oxlint-to-rdjsonl.js`:

```js
function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
  });
}

function readFileSafe(filename) {
  return require('node:fs').readFileSync(filename);
}

async function main() {
  const raw = await readStdin();
  const text = raw.trim();
  if (text === '') {
    return 0;
  }
  let diagnostics;
  try {
    diagnostics = JSON.parse(text);
  } catch (err) {
    process.stderr.write(`oxlint-to-rdjsonl: failed to parse oxlint JSON on stdin: ${err.message}\n`);
    return 1;
  }
  if (!Array.isArray(diagnostics)) {
    process.stderr.write(`oxlint-to-rdjsonl: expected a JSON array on stdin, got ${typeof diagnostics}\n`);
    return 1;
  }
  const out = convert(diagnostics, readFileSafe);
  for (const d of out) {
    process.stdout.write(JSON.stringify(d) + '\n');
  }
  return 0;
}

module.exports.main = main;

if (require.main === module) {
  main().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`oxlint-to-rdjsonl: ${err.stack || err.message}\n`);
    process.exit(1);
  });
}
```

- [ ] **Step 8.4: Run test to verify it passes**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: PASS — every test including the three CLI tests.

- [ ] **Step 8.5: Commit**

```bash
git add oxlint-to-rdjsonl.js oxlint-to-rdjsonl.test.js
git commit -m "feat(converter): CLI entrypoint reading stdin, writing rdjsonl"
```

---

## Task 9: Update `action.yml`

**Files:**
- Modify: `action.yml`

- [ ] **Step 9.1: Replace file contents**

Overwrite `action.yml` with:

```yaml
name: 'Run oxlint with reviewdog'
description: '🐶 Run oxlint with reviewdog on pull requests to improve code review experience.'
author: 'haya14busa (reviewdog)'
inputs:
  github_token:
    description: 'GITHUB_TOKEN.'
    required: true
    default: ${{ github.token }}
  level:
    description: 'Report level for reviewdog [info,warning,error]'
    required: false
    default: 'error'
  reporter:
    description: |
      Reporter of reviewdog command [github-check,github-pr-review].
      Default is github-pr-review.
      github-pr-review can use Markdown and add a link to rule page in reviewdog reports.
    required: false
    default: 'github-pr-review'
  filter_mode:
    description: |
      Filtering mode for the reviewdog command [added,diff_context,file,nofilter].
      Default is added.
    required: false
    default: 'added'
  fail_level:
    description: |
      If set to `none`, always use exit code 0 for reviewdog. Otherwise, exit code 1 for reviewdog if it finds at least 1 issue with severity greater than or equal to the given level.
      Possible values: [none,any,info,warning,error]
      Default is `none`.
    default: 'none'
  fail_on_error:
    description: |
      Deprecated, use `fail_level` instead.
      Exit code for reviewdog when errors are found [true,false]
      Default is `false`.
    deprecationMessage: Deprecated, use `fail_level` instead.
    required: false
    default: 'false'
  reviewdog_flags:
    description: 'Additional reviewdog flags'
    required: false
    default: ''
  oxlint_flags:
    description: "flags and args of oxlint command. Default: '.'"
    required: false
    default: '.'
  workdir:
    description: "The directory from which to look for and run oxlint. Default '.'"
    required: false
    default: '.'
  tool_name:
    description: 'Tool name to use for reviewdog reporter'
    required: false
    default: 'oxlint'
runs:
  using: 'composite'
  steps:
    - run: $GITHUB_ACTION_PATH/script.sh
      shell: bash
      env:
        REVIEWDOG_VERSION: v0.21.0
        INPUT_GITHUB_TOKEN: ${{ inputs.github_token }}
        INPUT_LEVEL: ${{ inputs.level }}
        INPUT_REPORTER: ${{ inputs.reporter }}
        INPUT_FILTER_MODE: ${{ inputs.filter_mode }}
        INPUT_FAIL_LEVEL: ${{ inputs.fail_level }}
        INPUT_FAIL_ON_ERROR: ${{ inputs.fail_on_error }}
        INPUT_REVIEWDOG_FLAGS: ${{ inputs.reviewdog_flags }}
        INPUT_OXLINT_FLAGS: ${{ inputs.oxlint_flags }}
        INPUT_WORKDIR: ${{ inputs.workdir }}
        INPUT_TOOL_NAME: ${{ inputs.tool_name }}
branding:
  icon: 'alert-octagon'
  color: 'blue'
```

- [ ] **Step 9.2: Verify YAML is well-formed**

Run: `python3 -c "import yaml; yaml.safe_load(open('action.yml'))"` (or `node -e "require('js-yaml')"` if yaml isn't available; the goal is to catch parse errors).
Expected: no error.

- [ ] **Step 9.3: Commit**

```bash
git add action.yml
git commit -m "feat(action): rename inputs eslint_flags -> oxlint_flags, drop node_options"
```

---

## Task 10: Update `script.sh`

**Files:**
- Modify: `script.sh`

- [ ] **Step 10.1: Replace file contents**

Overwrite `script.sh` with:

```sh
#!/bin/sh

cd "${GITHUB_WORKSPACE}/${INPUT_WORKDIR}" || exit 1

TEMP_PATH="$(mktemp -d)"
PATH="${TEMP_PATH}:$PATH"
export REVIEWDOG_GITHUB_API_TOKEN="${INPUT_GITHUB_TOKEN}"

echo '::group::🐶 Installing reviewdog ... https://github.com/reviewdog/reviewdog'
curl -sfL https://raw.githubusercontent.com/reviewdog/reviewdog/fd59714416d6d9a1c0692d872e38e7f8448df4fc/install.sh | sh -s -- -b "${TEMP_PATH}" "${REVIEWDOG_VERSION}" 2>&1
echo '::endgroup::'

npx --no-install -c 'oxlint --version' 2>/dev/null
if [ $? -ne 0 ]; then
  echo '::group:: Running `npm install` to install oxlint ...'
  set -e
  npm install
  set +e
  echo '::endgroup::'
fi

echo "oxlint version:$(npx --no-install -c 'oxlint --version')"

echo '::group:: Running oxlint with reviewdog 🐶 ...'
npx --no-install -c "oxlint --format=json ${INPUT_OXLINT_FLAGS:-'.'}" \
  | node "${GITHUB_ACTION_PATH}/oxlint-to-rdjsonl.js" \
  | reviewdog -f=rdjsonl \
      -name="${INPUT_TOOL_NAME}" \
      -reporter="${INPUT_REPORTER:-github-pr-review}" \
      -filter-mode="${INPUT_FILTER_MODE}" \
      -fail-level="${INPUT_FAIL_LEVEL}" \
      -fail-on-error="${INPUT_FAIL_ON_ERROR}" \
      -level="${INPUT_LEVEL}" \
      ${INPUT_REVIEWDOG_FLAGS}

reviewdog_rc=$?
echo '::endgroup::'
exit $reviewdog_rc
```

- [ ] **Step 10.2: Ensure the file is executable**

Run: `chmod +x script.sh && test -x script.sh && echo OK`
Expected: `OK`.

- [ ] **Step 10.3: Quick shell syntax check**

Run: `sh -n script.sh`
Expected: no output, exit 0.

- [ ] **Step 10.4: Commit**

```bash
git add script.sh
git commit -m "feat(action): swap eslint pipeline for oxlint + rdjsonl converter"
```

---

## Task 11: Delete `eslint-formatter-rdjson/`

**Files:**
- Delete: `eslint-formatter-rdjson/` (recursive)

- [ ] **Step 11.1: Verify nothing in the repo still imports it**

Run: `grep -rn --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=eslint-formatter-rdjson eslint-formatter-rdjson .`
Expected: only references in `docs/superpowers/`, `README.md` (if still present), and potentially files that are also scheduled for deletion/update. No reference from any file that's supposed to survive unmodified.

If the grep surfaces unexpected hits, stop and resolve them before deleting.

- [ ] **Step 11.2: Delete the directory**

Run: `git rm -r eslint-formatter-rdjson`
Expected: git reports deletions of every file under the directory.

- [ ] **Step 11.3: Commit**

```bash
git commit -m "chore: remove bundled eslint-formatter-rdjson"
```

---

## Task 12: Delete repo-root eslint/npm detritus

**Files:**
- Delete: `.eslintrc.js`
- Delete: `package.json`
- Delete: `package-lock.json`

- [ ] **Step 12.1: Verify nothing imports these**

Run: `grep -rn --exclude-dir=.git --exclude-dir=node_modules "eslintrc\|package-lock\|require(.package\.json" . | grep -v docs/superpowers`
Expected: no production code referencing the repo-root `package.json` or `.eslintrc.js`. References inside `docs/superpowers/` (the spec/plan) are fine.

- [ ] **Step 12.2: Delete the files**

Run: `git rm .eslintrc.js package.json package-lock.json`
Expected: three deletions staged.

- [ ] **Step 12.3: Commit**

```bash
git commit -m "chore: remove repo-root eslint config and package manifest"
```

---

## Task 13: Add `.oxlintrc.json`

**Files:**
- Create: `.oxlintrc.json`

- [ ] **Step 13.1: Write the config**

Create `.oxlintrc.json`:

```json
{
  "$schema": "https://raw.githubusercontent.com/oxc-project/oxc/main/npm/oxlint/configuration_schema.json",
  "rules": {
    "no-unused-vars": "error",
    "no-var": "error",
    "no-empty": "warn"
  },
  "ignorePatterns": [
    "test-subproject/",
    "node_modules/"
  ]
}
```

- [ ] **Step 13.2: Verify it's valid JSON**

Run: `python3 -m json.tool .oxlintrc.json > /dev/null`
Expected: exit 0, no error.

- [ ] **Step 13.3: Commit**

```bash
git add .oxlintrc.json
git commit -m "chore: add repo-root oxlint config for test fixtures"
```

---

## Task 14: Update `testdata/` fixtures for oxlint

**Files:**
- Modify: `testdata/test.js`
- Modify: `testdata/error.js`
- Modify: `testdata/empty.js`

**Rationale:** The current `testdata/error.js` uses a literal `🐶` outside a string, which eslint flagged as an unexpected character but oxlint's default JS parser treats as an identifier — different rule surface. Replace with a fixture that reliably triggers the rules pinned in `.oxlintrc.json` (`no-unused-vars`, `no-var`).

- [ ] **Step 14.1: Rewrite `testdata/error.js`**

Overwrite `testdata/error.js`:

```js
// Fires: no-var (var keyword), no-unused-vars (unusedVar never read)
var unusedVar = 1;
```

- [ ] **Step 14.2: Rewrite `testdata/test.js`**

Overwrite `testdata/test.js`:

```js
// Fires: no-var, no-empty (for body)
function sample() {
  for (var i = 0; i < 10; i++) {
  }
}

sample();
```

- [ ] **Step 14.3: Leave `testdata/empty.js` as-is**

Run: `cat testdata/empty.js`
Expected: `// empty` — a file with no diagnostics. This covers the "file with no issues" path.

- [ ] **Step 14.4: Smoke test: run oxlint locally against the fixtures and confirm JSON output is non-empty**

Run (requires oxlint installed globally or via `npx`): `npx --yes oxlint@latest --config .oxlintrc.json --format=json testdata/ > /tmp/out.json; echo exit=$?`
Expected: oxlint exits non-zero (because of rule violations) and `/tmp/out.json` contains a JSON array with at least 2 diagnostic entries.

If oxlint isn't available in the execution environment, mark this step as "deferred to CI" — the reviewdog workflow covers the same validation.

- [ ] **Step 14.5: Commit**

```bash
git add testdata/
git commit -m "test: rewrite testdata fixtures for oxlint's default rules"
```

---

## Task 15: Update `test-subproject/`

**Files:**
- Modify: `test-subproject/package.json`
- Delete: `test-subproject/.eslintrc.js`
- Delete: `test-subproject/package-lock.json` (regenerated in next task by the lock step, or leave for the action's `npm install` fallback)
- Modify: `test-subproject/sub-testdata/*.js` (same deterministic fixture treatment)

- [ ] **Step 15.1: Inspect current subproject fixtures**

Run: `ls test-subproject/sub-testdata/`
Expected: list of `.js` fixture files. Read each and note what rule they currently rely on.

- [ ] **Step 15.2: Rewrite `test-subproject/package.json`**

Overwrite:

```json
{
  "name": "action-eslint-subproject",
  "version": "1.0.0",
  "description": "A test subproject for testing reviewdog/action-eslint",
  "devDependencies": {
    "oxlint": "^0.15.0"
  },
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1"
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/reviewdog/action-eslint.git"
  },
  "keywords": [],
  "author": "",
  "license": "MIT",
  "bugs": {
    "url": "https://github.com/reviewdog/action-eslint/issues"
  },
  "homepage": "https://github.com/reviewdog/action-eslint#readme"
}
```

Note: the oxlint major version is provisional — bump to the current stable at the time of implementation by checking `npm view oxlint version`. Update `^0.15.0` accordingly before committing.

- [ ] **Step 15.3: Delete the old eslint config and lockfile**

Run: `git rm test-subproject/.eslintrc.js test-subproject/package-lock.json`
Expected: both deletions staged.

- [ ] **Step 15.4: Rewrite each file under `test-subproject/sub-testdata/` to fire oxlint rules**

For each `.js` file, replace the contents with something equivalent to:

```js
// Fires: no-var, no-unused-vars
var unused = 42;
```

(Keep each file distinct by name — the point is just that each file produces at least one diagnostic under oxlint defaults.)

- [ ] **Step 15.5: Regenerate the subproject lockfile**

Run: `cd test-subproject && npm install --package-lock-only && cd ..`
Expected: `test-subproject/package-lock.json` regenerated with only `oxlint` and its (few) transitive deps.

If `npm install --package-lock-only` is unavailable or fails locally, leave the lockfile absent; the action's `npm install` fallback in `script.sh` will create it at runtime.

- [ ] **Step 15.6: Commit**

```bash
git add test-subproject/
git commit -m "test(subproject): migrate to oxlint, regenerate lockfile"
```

---

## Task 16: Replace `.github/workflows/test.yml`

**Files:**
- Modify: `.github/workflows/test.yml`

- [ ] **Step 16.1: Overwrite contents**

```yaml
name: test
on:
  push:
    branches:
      - master
  pull_request:
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: "24"
      - name: Converter unit tests
        run: node --test oxlint-to-rdjsonl.test.js
```

Note: `cache: "npm"` was removed — there's no repo-root `package.json` / lockfile to cache against.

- [ ] **Step 16.2: Verify YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/test.yml'))"`
Expected: no error.

- [ ] **Step 16.3: Commit**

```bash
git add .github/workflows/test.yml
git commit -m "ci: run converter unit tests via node --test"
```

---

## Task 17: Update `.github/workflows/reviewdog.yml`

**Files:**
- Modify: `.github/workflows/reviewdog.yml`

- [ ] **Step 17.1: Overwrite contents**

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    name: runner / oxlint
    runs-on: ubuntu-latest

    strategy:
      fail-fast: false
      matrix:
        node_version:
          - "18"
          - "20"
          - "22"

    steps:
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
      - name: setup Node.js
        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6.4.0
        with:
          node-version: ${{ matrix.node_version }}
      - name: install oxlint for root fixtures
        run: npm install --no-save oxlint
      - name: oxlint-github-pr-check
        uses: ./
        with:
          tool_name: oxlint-github-pr-check
          reporter: github-pr-check
          level: info
          oxlint_flags: "--config .oxlintrc.json testdata/"
      - name: oxlint-github-check
        uses: ./
        with:
          tool_name: oxlint-github-check
          reporter: github-check
          level: warning
          oxlint_flags: "--config .oxlintrc.json testdata/"
      - name: oxlint-github-pr-review
        uses: ./
        with:
          tool_name: oxlint-github-pr-review
          reporter: github-pr-review
          oxlint_flags: "--config .oxlintrc.json testdata/"
      - name: oxlint-subproject-github-pr-review
        uses: ./
        with:
          tool_name: oxlint-subproject-github-pr-review
          reporter: github-pr-review
          workdir: ./test-subproject
          oxlint_flags: "sub-testdata/"
      - name: oxlint-subproject
        uses: ./
        with:
          tool_name: oxlint-subproject
          workdir: ./test-subproject
          oxlint_flags: "sub-testdata/"
          reporter: github-check
          level: warning
          filter_mode: file
```

Note: dropped the `--ignore-pattern /test-subproject/` arg since `.oxlintrc.json` already has `ignorePatterns`. For subproject steps, no `--config` flag — oxlint auto-discovers `test-subproject/.oxlintrc.json` if present, or falls back to defaults.

- [ ] **Step 17.2: Verify YAML**

Run: `python3 -c "import yaml; yaml.safe_load(open('.github/workflows/reviewdog.yml'))"`
Expected: no error.

- [ ] **Step 17.3: Commit**

```bash
git add .github/workflows/reviewdog.yml
git commit -m "ci(reviewdog): exercise action with oxlint across node matrix"
```

---

## Task 18: Delete `.github/workflows/npm-publish.yml`

**Files:**
- Delete: `.github/workflows/npm-publish.yml`

- [ ] **Step 18.1: Delete**

Run: `git rm .github/workflows/npm-publish.yml`
Expected: one deletion staged.

- [ ] **Step 18.2: Commit**

```bash
git commit -m "ci: remove npm-publish workflow (no npm package to publish)"
```

---

## Task 19: Rewrite `README.md`

**Files:**
- Modify: `README.md`

- [ ] **Step 19.1: Overwrite with new content**

Replace the entire file with:

```markdown
# GitHub Action: Run oxlint with reviewdog

[![depup](https://github.com/reviewdog/action-eslint/workflows/depup/badge.svg)](https://github.com/reviewdog/action-eslint/actions?query=workflow%3Adepup)
[![release](https://github.com/reviewdog/action-eslint/workflows/release/badge.svg)](https://github.com/reviewdog/action-eslint/actions?query=workflow%3Arelease)
[![GitHub release (latest SemVer)](https://img.shields.io/github/v/release/reviewdog/action-eslint?logo=github&sort=semver)](https://github.com/reviewdog/action-eslint/releases)

This action runs [oxlint](https://oxc.rs/docs/guide/usage/linter.html) with
[reviewdog](https://github.com/reviewdog/reviewdog) on pull requests to improve
code review experience.

## Migrating from older versions of this action (eslint)

Earlier versions of this action ran eslint. Starting with the oxlint rewrite,
the following breaking changes apply:

- `eslint_flags` input → `oxlint_flags`.
- `node_options` input removed (oxlint is a native binary; `NODE_OPTIONS` has no effect).
- `tool_name` default changed from `eslint` to `oxlint`.
- You must list `oxlint` (not `eslint`) in your project's `devDependencies` (or equivalent).

## Inputs

### `github_token`
**Required.** Default `${{ github.token }}`.

### `level`
Optional. Report level for reviewdog (`info`, `warning`, `error`). Same as reviewdog's `-level` flag.

### `reporter`
Optional. `github-pr-check`, `github-check`, or `github-pr-review`. Default `github-pr-review`.

### `tool_name`
Optional. Default `oxlint`. Becomes the check/run name on GitHub and the tool label in review comments.

### `filter_mode`
Optional. `added`, `diff_context`, `file`, or `nofilter`. Default `added`.

### `fail_level`
Optional. `none`, `any`, `info`, `warning`, or `error`. Default `none`.

### `fail_on_error`
Deprecated. Use `fail_level`.

### `reviewdog_flags`
Optional. Additional flags passed to reviewdog.

### `oxlint_flags`
Optional. Flags and args for the `oxlint` command. Default `.`.

### `workdir`
Optional. Directory from which to run oxlint. Default `.`.

## Example usage

Install oxlint in your project:

```shell
npm install --save-dev oxlint
```

See the [oxlint configuration docs](https://oxc.rs/docs/guide/usage/linter/config.html)
for creating a `.oxlintrc.json`. This action uses that config automatically.

### `.github/workflows/reviewdog.yml`

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    name: runner / oxlint
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: reviewdog/action-eslint@vX
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          reporter: github-pr-review
          oxlint_flags: "src/"
```

You can also set up Node and oxlint manually:

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: "20"
      - run: npm install
      - uses: reviewdog/action-eslint@vX
        with:
          reporter: github-check
          oxlint_flags: "src/"
```

### Matrix example with unique tool name

```yaml
name: reviewdog
on: [pull_request]
jobs:
  oxlint:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [18, 20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
      - uses: reviewdog/action-eslint@vX
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          reporter: github-check
          tool_name: oxlint-node-${{ matrix.node }}
          oxlint_flags: "src/"
```
```

Note: replace `@vX` with the actual release tag once a release is cut. Leave `@vX` in the plan so the implementer remembers the release step is still pending.

- [ ] **Step 19.2: Check the file renders as valid markdown**

Run: `node -e "require('node:fs').readFileSync('README.md','utf8')" && echo OK`
Expected: `OK`. (Purely a sanity read; we're not running a markdown linter.)

- [ ] **Step 19.3: Commit**

```bash
git add README.md
git commit -m "docs: rewrite README for oxlint"
```

---

## Task 20: Final integration pass

**Files:**
- None directly; this is a pre-merge verification task.

- [ ] **Step 20.1: Re-run converter tests**

Run: `node --test oxlint-to-rdjsonl.test.js`
Expected: all tests pass.

- [ ] **Step 20.2: Shell syntax check on `script.sh`**

Run: `sh -n script.sh`
Expected: no output, exit 0.

- [ ] **Step 20.3: Final grep for stale eslint references**

Run: `grep -rn --exclude-dir=.git --exclude-dir=docs/superpowers -i eslint .`
Expected: no matches. If anything surfaces, investigate — README screenshots URLs or the "Migrating from eslint" section are allowed; anything functional is not.

- [ ] **Step 20.4: Confirm the file list**

Run: `git status` and `git log --oneline master..HEAD`
Expected: clean working tree; ~19 commits corresponding to Tasks 1–19.

- [ ] **Step 20.5: Merge/PR**

No commit in this task — hand off for review.

---

## Self-review checklist

This section lives in the plan so the implementer can confirm the plan matches the spec before handing off.

| Spec section | Task(s) covering it |
|---|---|
| `action.yml` renames/removals | Task 9 |
| `script.sh` new pipeline | Task 10 |
| `oxlint-to-rdjsonl.js` transform rules | Tasks 1, 2, 5 |
| Byte-offset → line/column | Tasks 3, 4 |
| Edge cases (empty labels, read failure, invalid JSON, empty list) | Tasks 6, 8 |
| `convert` batch function | Task 7 |
| CLI exit codes | Task 8 |
| `testdata/` updates | Task 14 |
| `test-subproject/` updates | Task 15 |
| `.oxlintrc.json` | Task 13 |
| Delete eslint-formatter-rdjson | Task 11 |
| Delete repo-root eslint detritus | Task 12 |
| `.github/workflows/test.yml` | Task 16 |
| `.github/workflows/reviewdog.yml` | Task 17 |
| Delete `.github/workflows/npm-publish.yml` | Task 18 |
| README rewrite + migration callout | Task 19 |
| Final verification | Task 20 |
