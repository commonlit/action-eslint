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

module.exports = { mapSeverity, extractRuleCode, positionFromOffset, convertDiagnostic };
