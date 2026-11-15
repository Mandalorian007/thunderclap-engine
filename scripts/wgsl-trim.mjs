// The shaders' text, trimmed for the published build (ws/size-pass; Forge's scripts/wgsl-trim.ts,
// forgewilds G2): each template literal marked `/* wgsl */` loses its `//` comments and the spaces
// that start and end its lines. Every line stays where it was, so a WGSL compile message's line is
// the source's line, and every `${…}` is kept as written. A comment that runs into a `${…}` stays
// whole (what follows it would stop being a comment).
//
// scripts/build.mjs runs it over dist/**/*.js after tsc; scripts/check-bundle.mjs measures through
// it (the `wgslTrim()` Vite plugin), so the budgets hold what a game ships. The workspace (Vitest,
// the harness) keeps the shaders as written. Code that edits a shader's text at run time must not
// depend on a line's indentation or a comment (fx/billboard-wgsl.ts anchors without them).
// Tested by scripts/wgsl-trim.test.mjs. Node built-ins only.

const MARK = '/* wgsl */';

/** The index just past the `${…}` whose `${` is at `at` (strings, literals and braces skipped). */
function skipExpression(code, at) {
  let i = at + 2;
  let depth = 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') i += 2;
    else if (c === "'" || c === '"') {
      i++;
      while (i < code.length && code[i] !== c) i += code[i] === '\\' ? 2 : 1;
      i++;
    } else if (c === '`') i = skipLiteral(code, i);
    else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      i++;
      if (--depth === 0) return i;
    } else i++;
  }
  return i;
}

/** The index just past the template literal whose backtick is at `at`. */
function skipLiteral(code, at) {
  let i = at + 1;
  while (i < code.length) {
    const c = code[i];
    if (c === '\\') i += 2;
    else if (c === '`') return i + 1;
    else if (c === '$' && code[i + 1] === '{') i = skipExpression(code, i);
    else i++;
  }
  return i;
}

/**
 * One stretch of a literal's text between its backticks and `${…}`s, trimmed: `lineStart` when it
 * begins a line of the shader, `beforeHole` when a `${…}` follows it (its last line goes on).
 */
function trimText(text, lineStart, beforeHole) {
  const lines = text.split('\n');
  return lines
    .map((line, n) => {
      const last = n === lines.length - 1;
      let out = line;
      const comment = out.indexOf('//');
      if (comment >= 0 && !(last && beforeHole)) out = out.slice(0, comment);
      if (n > 0 || lineStart) out = out.replace(/^[ \t]+/, '');
      if (!last || !beforeHole) out = out.replace(/[ \t]+$/, '');
      return out;
    })
    .join('\n');
}

/** `code` (a module's source) with each `/* wgsl *\/` literal trimmed; the same string without one. */
export function trimWgsl(code) {
  let out = '';
  let from = 0;
  for (let mark = code.indexOf(MARK); mark >= 0; mark = code.indexOf(MARK, from)) {
    let open = mark + MARK.length;
    while (code[open] === ' ') open++;
    if (code[open] !== '`') {
      out += code.slice(from, open);
      from = open;
      continue;
    }
    out += code.slice(from, open + 1);
    let i = open + 1;
    let text = i;
    let lineStart = true;
    for (;;) {
      const c = code[i];
      if (c === undefined) throw new Error(`a /* wgsl */ literal never closes (at ${open})`);
      if (c === '\\') i += 2;
      else if (c === '`' || (c === '$' && code[i + 1] === '{')) {
        const hole = c === '$';
        out += trimText(code.slice(text, i), lineStart, hole);
        lineStart = false;
        if (!hole) {
          out += '`';
          from = i + 1;
          break;
        }
        const end = skipExpression(code, i);
        out += code.slice(i, end);
        i = text = end;
      } else i++;
    }
  }
  return out + code.slice(from);
}

/** The Vite plugin check:bundle builds with: the engine's sources, trimmed as dist ships them. */
export function wgslTrim() {
  return {
    name: 'tc-wgsl-trim',
    enforce: 'pre',
    transform(code, id) {
      if (!/\.[cm]?[jt]s$/.test(id) || !code.includes(MARK)) return null;
      const trimmed = trimWgsl(code);
      return trimmed === code ? null : { code: trimmed, map: null };
    },
  };
}
