/*
 * Lightweight C++ syntax highlighter and block (brace) analyser for the code viewer.
 */
(function (root) {
  'use strict';

  const KEYWORDS = new Set([
    'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'default', 'break', 'continue', 'return',
    'class', 'struct', 'enum', 'public', 'private', 'protected', 'virtual', 'const', 'static',
    'new', 'delete', 'using', 'namespace', 'this', 'true', 'false', 'nullptr', 'operator', 'template',
    'typename', 'inline', 'override'
  ]);
  const TYPES = new Set([
    'int', 'long', 'bool', 'char', 'double', 'float', 'void', 'unsigned', 'size_t', 'auto',
    'string', 'vector', 'set', 'deque', 'ostringstream', 'istringstream', 'iterator',
    'Event', 'EventType', 'Config', 'Statistics', 'ARQProtocol', 'StopAndWait', 'GoBackN', 'SelectiveRepeat'
  ]);

  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const span = (cls, text) => '<span class="tok-' + cls + '">' + esc(text) + '</span>';

  // Returns an array of HTML strings, one per source line.
  function highlight(source) {
    const lines = source.replace(/\r\n/g, '\n').split('\n');
    let inComment = false;
    return lines.map((line) => {
      let html = '';
      let i = 0;
      if (/^\s*#/.test(line) && !inComment) {
        const m = line.match(/^(\s*#\s*\w+)(\s*)(.*)$/);
        return span('pre', m[1]) + m[2] + (m[3] ? span('str', m[3]) : '');
      }
      while (i < line.length) {
        if (inComment) {
          const end = line.indexOf('*/', i);
          const stop = end === -1 ? line.length : end + 2;
          html += span('com', line.slice(i, stop));
          i = stop;
          if (end !== -1) inComment = false;
          continue;
        }
        const rest = line.slice(i);
        let m;
        if (rest.startsWith('//')) { html += span('com', rest); break; }
        if (rest.startsWith('/*')) { inComment = true; continue; }
        if ((m = rest.match(/^"(?:\\.|[^"\\])*"/))) { html += span('str', m[0]); i += m[0].length; continue; }
        if ((m = rest.match(/^'(?:\\.|[^'\\])'/))) { html += span('str', m[0]); i += m[0].length; continue; }
        if ((m = rest.match(/^\d+(?:LL|L|U)?/))) { html += span('num', m[0]); i += m[0].length; continue; }
        if ((m = rest.match(/^[A-Za-z_]\w*/))) {
          const word = m[0];
          const after = rest.slice(word.length);
          if (KEYWORDS.has(word)) html += span('kw', word);
          else if (TYPES.has(word)) html += span('type', word);
          else if (/^[A-Z][A-Z0-9_]+$/.test(word)) html += span('const', word);
          else if (/^\s*\(/.test(after)) html += span('fn', word);
          else html += esc(word);
          i += word.length;
          continue;
        }
        if ((m = rest.match(/^(<<|>>|==|!=|<=|>=|&&|\|\||\+\+|--|->|::|[+\-*/%=<>!&|?:])/))) {
          html += span('op', m[0]); i += m[0].length; continue;
        }
        html += esc(line[i]);
        i++;
      }
      return html || ' ';
    });
  }

  // Returns [{ start, end }] (1-based, inclusive) for every { ... } block.
  function blocks(source) {
    const text = source.replace(/\r\n/g, '\n');
    const out = [];
    const stack = [];
    let line = 1;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      const n = text[i + 1];
      if (c === '\n') { line++; continue; }
      if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; i--; continue; }
      if (c === '/' && n === '*') {
        i += 2;
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
        i++;
        continue;
      }
      if (c === '"' || c === "'") {
        i++;
        while (i < text.length && text[i] !== c) { if (text[i] === '\\') i++; i++; }
        continue;
      }
      if (c === '{') stack.push(line);
      else if (c === '}' && stack.length) out.push({ start: stack.pop(), end: line });
    }
    return out;
  }

  // Innermost block that encloses a statement on `line` (block header lines excluded).
  function enclosingBlock(list, line) {
    let best = null;
    for (const b of list) {
      if (b.start < line && line <= b.end && (!best || b.end - b.start < best.end - best.start)) best = b;
    }
    return best;
  }

  // Name of the function whose body contains `line`, e.g. "GoBackN::receiveAck()".
  function functionAt(lines, line) {
    const fnRe = /^\s*(?:virtual\s+)?(?:[\w:<>*&]+\s+)+?[*&]?(\w+)\s*\(([^)]*)\)\s*(?:const\s*)?\{\s*$/;
    const ctorRe = /^\s{4}(\w+)\(const Config& c\)/;
    for (let i = line - 1; i >= 0; i--) {
      const l = lines[i];
      const m = l.match(fnRe);
      if (m && !/^(if|for|while|switch)$/.test(m[1])) return m[1] + '()';
      const c = l.match(ctorRe);
      if (c) return c[1] + '()';
      if (/^(class|struct)\s/.test(l)) return null;
      if (/^\S.*\{\s*$/.test(l) && !/^(class|struct)/.test(l)) {
        const g = l.match(/(\w+)\s*\(/);
        return g ? g[1] + '()' : null;
      }
    }
    return null;
  }

  function classAt(lines, line) {
    for (let i = line - 1; i >= 0; i--) {
      const m = lines[i].match(/^class\s+(\w+)/);
      if (m) return m[1];
      if (/^\S.*\)\s*\{\s*$/.test(lines[i])) return null;
      if (/^\};/.test(lines[i]) && i < line - 1) return null;
    }
    return null;
  }

  root.CppView = { highlight, blocks, enclosingBlock, functionAt, classAt };
})(window);
