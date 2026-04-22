# Design: Migrate `action-eslint` to oxlint

**Status:** approved (spec)
**Date:** 2026-04-21

## Summary

In-place rewrite of this composite GitHub Action to run [oxlint](https://oxc.rs/docs/guide/usage/linter.html) with reviewdog instead of eslint. All eslint-specific code, inputs, tests, documentation, and the bundled `eslint-formatter-rdjson` are removed. This is a breaking change for existing consumers; there is no backward-compatibility shim.

## Motivation

Users of the action want to run oxlint — a faster Rust-based linter — through the same reviewdog integration this action provides. Rather than maintain two parallel actions, the repo is being repurposed.

## Non-goals

- Supporting both eslint and oxlint from the same action.
- Preserving input names for backward compatibility.
- Renaming the GitHub repository itself (that is an operational step outside this design).
- Releasing / version-tagging (handled by release tooling).

## Architecture

Composite action with a single bash entrypoint (`script.sh`) invoked by `action.yml`. The entrypoint:

1. Installs reviewdog from its release script (unchanged from current behavior).
2. Verifies oxlint is available via `npx --no-install -c 'oxlint --version'`; if absent, runs `npm install` to pick up the consumer's declared `devDependencies`.
3. Pipes `oxlint --format=json <oxlint_flags>` through a small Node converter (`oxlint-to-rdjsonl.js`) into `reviewdog -f=rdjsonl`.

The converter is the only new moving part. Everything else is renames and deletions.

## Components

### `action.yml`

**Renamed inputs:**
- `eslint_flags` → `oxlint_flags` (default `.`)
- `tool_name` default: `eslint` → `oxlint`

**Removed inputs:**
- `node_options` — oxlint is a Rust binary; `NODE_OPTIONS` has no effect. Dropping the input is cleaner than keeping a no-op.

**Unchanged inputs:**
`github_token`, `level`, `reporter`, `filter_mode`, `fail_level`, `fail_on_error`, `reviewdog_flags`, `workdir`.

**Env plumbing:** `INPUT_ESLINT_FLAGS` → `INPUT_OXLINT_FLAGS`. `NODE_OPTIONS` removed from `env:`.

**Metadata:** `name` and `description` reworded for oxlint. Branding (`alert-octagon`, `blue`) unchanged.

### `script.sh`

Mirror of current structure, with eslint calls replaced:

```sh
#!/bin/sh
cd "${GITHUB_WORKSPACE}/${INPUT_WORKDIR}" || exit 1

TEMP_PATH="$(mktemp -d)"
PATH="${TEMP_PATH}:$PATH"
export REVIEWDOG_GITHUB_API_TOKEN="${INPUT_GITHUB_TOKEN}"

echo '::group::🐶 Installing reviewdog ...'
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
npx --no-install -c "oxlint --format=json ${INPUT_OXLINT_FLAGS:-.}" \
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

Pipefail is not enabled (matches current behavior). Reviewdog's exit code is the action's exit code.

### `oxlint-to-rdjsonl.js`

Stdin-to-stdout converter. Node built-ins only; no devDeps.

**Input:** oxlint's JSON output — a JSON array of diagnostics rendered by miette's `JSONReportHandler`:

```json
{
  "message": "...",
  "code": "eslint(no-unused-vars)",
  "severity": "error" | "warning" | "advice",
  "url": "https://oxc.rs/...",
  "help": "...",
  "filename": "path/to/file.js",
  "labels": [{ "span": { "offset": 123, "length": 5 } }]
}
```

**Output:** rdjsonl — one JSON object per line:

```json
{"message":"...","location":{"path":"path/to/file.js","range":{"start":{"line":10,"column":5},"end":{"line":10,"column":10}}},"severity":"ERROR","code":{"value":"no-unused-vars","url":"https://oxc.rs/..."},"source":{"name":"oxlint","url":"https://oxc.rs/docs/guide/usage/linter.html"}}
```

**Transform rules:**

| Input field | Output field | Notes |
|---|---|---|
| `message` | `message` | Pass through |
| `severity` | `severity` | `error` → `ERROR`, `warning` → `WARNING`, `advice` → `INFO` |
| `code` | `code.value` | Strip `plugin(...)` wrapper: `eslint(no-unused-vars)` → `no-unused-vars`. Bare code passed through. Missing code → omit `code` entirely. |
| `url` | `code.url` | Pass through if present; omit otherwise |
| `filename` | `location.path` | Pass through |
| `labels[0].span` | `location.range` | Convert byte offsets to 1-based line + 1-based column by reading the source file |
| (literal) | `source.name` / `source.url` | Always `"oxlint"` and oxlint docs URL |

**Byte-offset → line/column conversion:**
- Read the file referenced by `filename` as a UTF-8 `Buffer`, once per run, cached.
- Walk bytes: increment line on `\n` (byte `0x0A`), reset column to 1 after newline, increment column per byte otherwise.
- Line and column are both 1-based UTF-8 byte positions. This matches the rdjson output emitted by the existing `eslint-formatter-rdjson` (which converts eslint's UTF-16 columns to UTF-8 bytes) — reviewdog's expected encoding on this action's wire format.
- Because oxlint's `offset` is already a UTF-8 byte offset (miette writes `label.offset()` which is source byte offset), no UTF-16 conversion is involved.
- `range.start` = position at `offset`. `range.end` = position at `offset + length`.

**Edge cases:**
- Empty `labels` array or absent `filename`: emit diagnostic with `location.path` (if available) but no `range`. Reviewdog accepts file-level diagnostics.
- Multiple labels: use first only. Matches existing formatter behavior (one location per message).
- File read failure (e.g., file deleted between lint and convert): emit file-level diagnostic without `range`, continue.
- Invalid JSON on stdin: print error to stderr, exit 1. Silent drop would mask a broken lint run as "no issues."
- Empty diagnostic array: zero output lines, exit 0.

### `oxlint-to-rdjsonl.test.js`

Node's built-in `node:test` runner. No devDeps.

**Cases:**
- Severity mapping across all three values.
- Rule code extraction: `plugin(rule)`, bare, missing.
- URL pass-through and absence.
- Offset → line/column: single-line, multi-line, offset at newline boundary, offset at EOF, UTF-8 multi-byte character.
- Empty `labels` → file-level diagnostic, no `range`.
- Multiple `labels` → first wins.
- File-read failure → file-level diagnostic, no crash.
- Invalid JSON on stdin → exit 1, message on stderr.
- Empty diagnostic list → zero lines, exit 0.

Fixtures: small inline JSON + source files under `testdata/converter/` (`simple.js`, `multiline.js`, `utf8.js`).

Run: `node --test oxlint-to-rdjsonl.test.js`.

### `testdata/` and `test-subproject/`

- `testdata/*.js`: adjust content so oxlint's default ruleset fires at least one diagnostic per file (validates the pipeline without binding tests to oxlint rule internals).
- `.oxlintrc.json` at repo root to pin rules for deterministic test output.
- `test-subproject/package.json`: swap `eslint` dep for `oxlint`, regenerate lockfile.
- `test-subproject/.eslintrc.js`: delete. The subproject relies on oxlint's default rules. If the end-to-end test needs a specific rule fired, a `test-subproject/.oxlintrc.json` is added alongside (decided during implementation when writing the fixture).
- `testdata/converter/*.js`: new fixtures for converter unit tests.

### `.github/workflows/`

Audited during implementation. Any workflow exercising the action end-to-end will install `oxlint` instead of `eslint`. Workflow names are preserved where possible to keep README badges valid.

### `README.md`

Full rewrite:

- Title: "GitHub Action: Run oxlint with reviewdog"
- Intro links oxlint docs.
- Prereq: `npm install -D oxlint`.
- Config references `.oxlintrc.json`.
- Inputs section reflects the Section 4 changes.
- Example YAML updated throughout (`oxlint_flags`, `tool_name: oxlint`).
- Screenshot URLs left as placeholders; implementation PR notes they need re-capture.
- Top of file: short "Migrating from action-eslint" callout listing renamed/removed inputs.

## Files

**Add:**
- `oxlint-to-rdjsonl.js`
- `oxlint-to-rdjsonl.test.js`
- `.oxlintrc.json`
- `testdata/converter/{simple,multiline,utf8}.js`

**Modify:**
- `action.yml`
- `script.sh`
- `README.md`
- `testdata/*.js`
- `test-subproject/package.json` (+ regenerate `test-subproject/package-lock.json`)
- `.github/workflows/*.yml` (audit first)

**Delete:**
- `eslint-formatter-rdjson/` (entire directory)
- `.eslintrc.js`
- `package.json` (repo root)
- `package-lock.json` (repo root)
- `test-subproject/.eslintrc.js`

## Error handling summary

| Failure | Behavior |
|---|---|
| oxlint not installed | `npm install` in consumer project (existing fallback pattern) |
| oxlint emits invalid JSON | Converter exits 1, stderr explains; action fails loudly |
| Source file unreadable | File-level diagnostic without `range`, pipeline continues |
| Reviewdog non-zero exit | Propagated as action exit code (unchanged) |

## Out of scope

- Backward-compat shim for `eslint_flags` / `node_options`.
- Snapshot-testing reviewdog's rendered output.
- Running oxlint's own test suite.
- Git tagging or release automation.
- Repository rename on GitHub.

## Open questions

None. All design decisions resolved during brainstorming.
