const WRITES = new Set(['write_file', 'edit_file', 'notebook_edit']);

function changedPaths(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const seen = new Map();
  for (const r of list) {
    if (!r || !WRITES.has(String(r.name || ''))) continue;

    if (r.ok === false) continue;

    const p = String(r.target || '').split(' ')[0];
    if (!p) continue;
    if (seen.has(p)) seen.get(p).times += 1;
    else seen.set(p, { path: p, times: 1 });
  }
  return [...seen.values()];
}

module.exports = { changedPaths, WRITES };
