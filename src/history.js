const fs = require('fs');
const path = require('path');

const KEEP = 1000;

function fileOf(root) {
  return path.join(root, 'history.jsonl');
}

function samePath(a, b) {
  return String(a || '').normalize('NFC') === String(b || '').normalize('NFC');
}

function add(root, { text, workspace }) {
  const line = String(text || '').trim();
  if (!line || !root) return;
  try {
    const last = recent(root, { workspace, limit: 1 })[0];
    if (last === line) return;
    fs.mkdirSync(root, { recursive: true });
    fs.appendFileSync(
      fileOf(root),
      JSON.stringify({ text: line, workspace: String(workspace || ''), at: Date.now() }) + '\n'
    );
  } catch {

  }
}

function recent(root, { workspace, limit = 100 } = {}) {
  let text;
  try {
    text = fs.readFileSync(fileOf(root), 'utf8');
  } catch {
    return [];
  }
  const out = [];
  const seen = new Set();
  const lines = text.split('\n');

  for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const l = lines[i];
    if (!l) continue;
    let o;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (workspace && !samePath(o.workspace, workspace)) continue;
    const s = String(o.text || '').trim();

    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function recentSkills(root, { workspace, limit = 5 } = {}) {
  const out = [];
  const seen = new Set();
  for (const text of recent(root, { workspace, limit: 200 })) {
    const m = /^\s*\/([A-Za-z0-9_-]+)/.exec(text);
    if (!m) continue;
    const name = m[1];
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= limit) break;
  }
  return out;
}

function trim(root) {
  try {
    const lines = fs.readFileSync(fileOf(root), 'utf8').split('\n').filter(Boolean);
    if (lines.length <= KEEP) return;
    fs.writeFileSync(fileOf(root), lines.slice(-KEEP).join('\n') + '\n');
  } catch {

  }
}

module.exports = { add, recent, recentSkills, trim, samePath, fileOf, KEEP };
