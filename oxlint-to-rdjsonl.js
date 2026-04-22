'use strict';

function mapSeverity(s) {
  if (s === 'error') return 'ERROR';
  if (s === 'warning') return 'WARNING';
  if (s === 'advice') return 'INFO';
  return 'UNKNOWN_SEVERITY';
}

function extractRuleCode(code) {
  if (code === undefined || code === null) return undefined;
  const match = /^[^(]+\(([^)]+)\)$/.exec(code);
  return match ? match[1] : code;
}

// Convert a UTF-8 byte offset into {line, column}, both 1-based.
// column is a 1-based UTF-8 byte position within its line (reviewdog's expected encoding).
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

function convert(diagnostics, fileReader) {
  return diagnostics.map((d) => convertDiagnostic(d, fileReader));
}

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

module.exports = {
  mapSeverity,
  extractRuleCode,
  positionFromOffset,
  convertDiagnostic,
  convert,
  main,
};

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`oxlint-to-rdjsonl: ${err.stack || err.message}\n`);
      process.exit(1);
    });
}
