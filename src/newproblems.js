function newProblems(before, after, 幅 = 0) {
  const 前 = new Map();
  for (const [uri, list] of Array.isArray(before) ? before : []) {
    前.set(keyOf(uri), Array.isArray(list) ? list : []);
  }
  const out = [];
  for (const [uri, list] of Array.isArray(after) ? after : []) {
    const 元 = 前.get(keyOf(uri)) || [];
    const 増えた = (Array.isArray(list) ? list : []).filter((d) => !元.some((o) => 同じ(o, d, 幅)));
    if (増えた.length) out.push([uri, 増えた]);
  }
  return out;
}

function keyOf(uri) {
  if (!uri) return '';
  if (typeof uri === 'string') return uri;
  return String(uri.fsPath || uri.path || uri.toString());
}

function 同じ(a, b, 幅 = 0) {
  if (!a || !b) return false;
  const 行 = (d) => (d.range && d.range.start ? d.range.start.line : -1);
  return (
    String(a.message || '') === String(b.message || '') &&
    Number(a.severity) === Number(b.severity) &&
    Math.abs(行(a) - 行(b)) <= Math.max(0, Number(幅) || 0)
  );
}

function formatNewProblems(list, root, rel, max = 50) {
  const SEV = ['Error', 'Warning', 'Information', 'Hint'];
  const lines = [];
  let n = 0;
  let 全部 = 0;
  for (const [uri, ds] of Array.isArray(list) ? list : []) {
    for (const d of ds) {
      全部 += 1;
      if (n >= max) continue;
      n += 1;
      const p = keyOf(uri);
      const 道 = root && rel ? rel(root, p) : p;
      const at = d.range && d.range.start ? `:${d.range.start.line + 1}` : '';
      lines.push(`  ${SEV[d.severity] || 'Error'}  ${道}${at}  ${d.message || ''}`);
    }
  }
  if (!lines.length) return '';
  return (
    `**この直しのあとで増えた誤りが ${全部} 件あります**` +
    (全部 > n ? `（${n} 件だけ出します）` : '') +
    ':\n' +
    lines.join('\n') +
    '\n元から在った物は出していません。**この直しで増えた分だけ**です。'
  );
}

module.exports = { newProblems, formatNewProblems };
