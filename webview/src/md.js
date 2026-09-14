const PATH_LIKE = /^[\w.@/-]+\.[A-Za-z][\w]{0,9}(?::\d+)?$/;

function pathish(s) {
  const t = String(s || '').trim();
  if (!t || t.length > 200) return null;
  if (!PATH_LIKE.test(t)) return null;

  if (t.startsWith('.')) return null;
  return t;
}

const { normalizeLang } = require('./highlight');

function esc(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

function render(md) {
  const blocks = [];

  let text = String(md).replace(/^( *)```(\w*)\n([\s\S]*?)\n\1```[ \t]*$/gm, (_m, indent, lang, code) => {
    code = code.split('\n').map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l.replace(/^ +/, ''))).join('\n');

    const l = normalizeLang(lang);
    const cls = l ? ' class="language-' + l + '"' : '';
    const attr = l ? ' data-lang="' + l + '"' : '';
    blocks.push('<pre' + attr + '><code' + cls + '>' + esc(code) + '</code></pre>');
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });
  text = esc(text)
    .replace(/`([^`\n]+)`/g, (_m, body) => {

      const p = pathish(body);
      return p
        ? '<code class="maybepath" data-path="' + p.replace(/"/g, '&quot;') + '">' + body + '</code>'
        : '<code>' + body + '</code>';
    })

    .replace(/\*\*(?=\S)([^\n]*?\S)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;
  let listType = null;
  let listStart = null;
  const flush = () => {
    if (list) {
      const start = listType === 'ol' && listStart !== 1 ? ' start="' + listStart + '"' : '';
      out.push('<' + listType + start + '>' + list.join('') + '</' + listType + '>');
      list = null;
      listType = null;
      listStart = null;
    }
  };
  const splitTableRow = (line) => {
    const cells = line.split('|');
    if (cells[0].trim() !== '') return null;
    if (cells[cells.length - 1].trim() !== '') return null;
    const trimmed = cells.slice(1, -1).map((cell) => cell.trim());
    if (trimmed.length === 0 || trimmed.every((cell) => cell === '')) return null;
    return trimmed;
  };
  const isTableDivider = (line) => {
    const cells = splitTableRow(line);
    return cells && cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
  };
  const renderTableCell = (cell, tag) => '<' + tag + '>' + cell + '</' + tag + '>';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = raw.trimEnd();
    const ph = /^\u0000(\d+)\u0000$/.exec(line.trim());
    if (ph) {
      flush();
      out.push(blocks[Number(ph[1])]);
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      out.push('<hr>');
      continue;
    }

    if (/^\s*&gt; ?/.test(line)) {
      flush();
      const parts = [];
      while (i < lines.length) {
        const q = /^\s*&gt; ?(.*)$/.exec(lines[i].trimEnd());
        if (!q) break;
        if (q[1].trim()) parts.push('<p>' + q[1] + '</p>');
        i += 1;
      }
      i -= 1;
      out.push('<blockquote>' + parts.join('') + '</blockquote>');
      continue;
    }
    const tableHead = splitTableRow(line);
    if (tableHead && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
      const rows = [];
      i += 2;
      rows.push('<tr>' + tableHead.map((cell) => renderTableCell(cell, 'th')).join('') + '</tr>');
      while (i < lines.length) {
        const cells = splitTableRow(lines[i]);
        if (!cells) {
          i -= 1;
          break;
        }
        rows.push('<tr>' + cells.map((cell) => renderTableCell(cell, 'td')).join('') + '</tr>');
        i += 1;
      }
      out.push('<table><thead>' + rows.shift().replace('<tr>', '<tr>').replace('</tr>', '</tr>') + '</thead><tbody>' + rows.join('') + '</tbody></table>');
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      if (listType !== 'ul') flush();
      listType = 'ul';
      (list = list || []).push('<li>' + li[1] + '</li>');
      continue;
    }
    const oli = /^\s*(\d+)\.\s+(.*)$/.exec(line);
    if (oli) {
      if (listType !== 'ol') flush();
      if (!list) {
        list = [];
        listType = 'ol';
        listStart = Number(oli[1]);
      }
      list.push('<li>' + oli[2] + '</li>');
      continue;
    }
    flush();
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      out.push('<h3>' + h[1] + '</h3>');
      continue;
    }
    if (line.trim()) out.push('<p>' + line + '</p>');
  }
  flush();
  return out.join('');
}

module.exports = { esc, render, pathish };
