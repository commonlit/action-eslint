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

module.exports = { mapSeverity, extractRuleCode, positionFromOffset };
