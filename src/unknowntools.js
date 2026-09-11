const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_NAMES = 200;

const MAX_KEYS = 12;

function fileOf() {
  return process.env.CHATGPT_BRIDGE_UNKNOWN_TOOLS
    ? path.resolve(process.env.CHATGPT_BRIDGE_UNKNOWN_TOOLS)
    : path.join(os.homedir(), '.chatgpt-bridge', 'unknown-tools.json');
}

function readAll() {
  try {
    const raw = fs.readFileSync(fileOf(), 'utf8');
    const o = JSON.parse(raw);
    return o && typeof o === 'object' && o.names && typeof o.names === 'object' ? o : { names: {} };
  } catch {

    return { names: {} };
  }
}

function noteUnknown(name, input, when) {
  const key = String(name || '').trim().slice(0, 80);
  if (!key) return null;
  try {
    const o = readAll();
    const now = when || new Date().toISOString();
    const rec = o.names[key] || { n: 0, first: now, last: now, keys: [] };
    rec.n += 1;
    rec.last = now;

    for (const k of Object.keys(input && typeof input === 'object' ? input : {})) {
      if (rec.keys.length >= MAX_KEYS) break;
      if (!rec.keys.includes(k)) rec.keys.push(k);
    }
    o.names[key] = rec;

    const 並び = Object.keys(o.names);
    if (並び.length > MAX_NAMES) {
      並び
        .sort((a, b) => o.names[a].n - o.names[b].n)
        .slice(0, 並び.length - MAX_NAMES)
        .forEach((k) => delete o.names[k]);
    }
    const f = fileOf();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(o, null, 1));
    return rec.n;
  } catch {
    return null;
  }
}

function listUnknown() {
  const o = readAll();
  return Object.keys(o.names)
    .map((name) => ({ name, ...o.names[name] }))
    .sort((a, b) => b.n - a.n);
}

module.exports = { noteUnknown, listUnknown, fileOf, MAX_NAMES };
