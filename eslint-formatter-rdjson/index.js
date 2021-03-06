// ESLint Formatter to Output Reviewdog Diagnostic Format (RDFormat)
// https://github.com/reviewdog/reviewdog/blob/1d8f6d6897dcfa67c33a2ccdc2ea23a8cca96c8c/proto/rdf/reviewdog.proto

// https://github.com/eslint/eslint/blob/091e52ae1ca408f3e668f394c14d214c9ce806e6/lib/shared/types.js#L11
// https://github.com/eslint/eslint/blob/82669fa66670a00988db5b1d10fe8f3bf30be84e/lib/shared/config-validator.js#L40
function convertSeverity(s) {
  if (s === 0) { // off
    return 'INFO';
  } else if (s === 1) {
    return 'WARNING';
  } else if (s === 2) {
    return 'ERROR';
  }
  return 'UNKNOWN_SEVERITY';
}

function isHighSurrogate(ch) {
  return 0xD800 <= ch && ch < 0xDC00;
}

function isLowSurrogate(ch) {
  return 0xDC00 <= ch && ch < 0xE000;
}

function utf8length(str) {
  let length = 0;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    if (isHighSurrogate(ch)) {
      i++;
      length += 4;
      if (i >= str.length || !isLowSurrogate(str.charCodeAt(i))) {
        throw new Error("invalid surrogate character");
      }
    } else if (isLowSurrogate(ch)) {
      throw new Error("invalid surrogate character");
    } else if (ch < 0x80) {
      length++;
    } else if (ch < 0x0800) {
      length += 2;
    } else {
      length += 3;
    }
  }
  return length;
}

function positionFromUTF16CodeUnitOffset(offset, text) {
  const lines = text.split('\n');
  let lnum = 1;
  let column = 0;
  let lengthSoFar = 0;
  for (const line of lines) {
    if (offset <= lengthSoFar + line.length) {
      const lineText = line.slice(0, offset-lengthSoFar);
      // +1 because eslint offset is a bit weird and will append text right
      // after the offset.
      column = utf8length(lineText) + 1;
      break;
    }
    lengthSoFar += line.length + 1; // +1 for line-break.
    lnum++;
  }
  return {line: lnum, column: column};
}

function positionFromLineAndUTF16CodeUnitOffsetColumn(line, column, sourceLines) {
  let col = 0;
  if (sourceLines.length >= line) {
    const lineText = sourceLines[line-1].slice(0, column);
    col = utf8length(lineText);
  }
  return {line: line, column: col};
}

function commonSuffixLength(str1, str2) {
  let i = 0;
  let seenSurrogate = false;
  for (i = 0; i < str1.length && i < str2.length; ++i) {
    const ch1 = str1.charCodeAt(str1.length-(i+1));
    const ch2 = str2.charCodeAt(str2.length-(i+1));
    if (ch1 !== ch2) {
      if (seenSurrogate) {
        if (!isHighSurrogate(ch1) || !isHighSurrogate(ch2)) {
          throw new Error("invalid surrogate character");
        }
        // i is now between a low surrogate and a high surrogate.
        // we need to remove the low surrogate from the common suffix
        // to avoid breaking surrogate pairs.
        i--;
      }
      break;
    }
    seenSurrogate = isLowSurrogate(ch1);
  }
  return i;
}

function buildMinimumSuggestion(fix, source) {
  const l = commonSuffixLength(fix.text, source.slice(fix.range[0], fix.range[1]));
  return {
    range: {
      start: positionFromUTF16CodeUnitOffset(fix.range[0], source),
      end: positionFromUTF16CodeUnitOffset(fix.range[1] - l, source)
    },
    text: fix.text.slice(0, fix.text.length - l)
  };
}

module.exports = function (results, data) {
  const rdjson = {
    source: {
      name: 'eslint',
      url: 'https://eslint.org/'
    },
    diagnostics: []
  };

  results.forEach(result => {
    const filePath = result.filePath;
    const source = result.source;
    const sourceLines = source ? source.split('\n') : [];
    result.messages.forEach(msg => {
      let diagnostic = {
        message: msg.message,
        location: {
          path: filePath,
          range: {
            start: positionFromLineAndUTF16CodeUnitOffsetColumn(msg.line, msg.column, sourceLines),
            end:positionFromLineAndUTF16CodeUnitOffsetColumn(msg.endLine, msg.endColumn, sourceLines)
          }
        },
        severity: convertSeverity(msg.severity),
        code: {
          value: msg.ruleId,
          url: (data.rulesMeta[msg.ruleId] && data.rulesMeta[msg.ruleId].docs ? data.rulesMeta[msg.ruleId].docs.url : '')
        },
        original_output: JSON.stringify(msg)
      };

      if (msg.fix) {
        diagnostic.suggestions = [buildMinimumSuggestion(msg.fix, source)];
      }

      rdjson.diagnostics.push(diagnostic);
    });
  });
  return JSON.stringify(rdjson);
};
