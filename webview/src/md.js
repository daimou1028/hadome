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
  let text = String(md).replace(/```(\w*)\n([\s\S]*?)\n```/g, (_m, lang, code) => {

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
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = null;
  const flush = () => {
    if (list) {
      out.push('<ul>' + list.join('') + '</ul>');
      list = null;
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const ph = /^\u0000(\d+)\u0000$/.exec(line.trim());
    if (ph) {
      flush();
      out.push(blocks[Number(ph[1])]);
      continue;
    }
    const li = /^\s*[-*]\s+(.*)$/.exec(line);
    if (li) {
      (list = list || []).push('<li>' + li[1] + '</li>');
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
