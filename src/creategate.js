const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WINDOW_MS = 3600000;
const MAX_ENTRIES = 100;

function dirPath() {
  return process.env.CHATGPT_BRIDGE_CREATE_TIMES_DIR || path.join(os.homedir(), '.chatgpt-bridge', 'create-times');
}

function filePath(key) {
  const id = String(key || '');
  const name = /^[A-Za-z0-9_-]{1,80}$/.test(id) ? id : 'h-' + crypto.createHash('sha1').update(id).digest('hex');
  return path.join(dirPath(), name + '.json');
}

function readLast(key, now = Date.now()) {
  try {
    const entries = JSON.parse(fs.readFileSync(filePath(key), 'utf8'));
    if (!Array.isArray(entries)) return null;
    const fresh = entries.filter((t) => typeof t === 'number' && Number.isFinite(t) && now - t < WINDOW_MS);
    if (fresh.length === 0) return null;
    return Math.max(...fresh);
  } catch {
    return null;
  }
}

function record(key, at = Date.now()) {
  try {
    const file = filePath(key);
    let entries = [];
    try {
      const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(prev)) entries = prev.filter((t) => typeof t === 'number' && Number.isFinite(t));
    } catch {  }
    entries.push(at);
    entries = entries.filter((t) => at - t < WINDOW_MS).slice(-MAX_ENTRIES);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } catch {

  }
}

async function waitGap({ key, gapMs = 0, jitterRatio = 0.4, nowFn = Date.now, sleep } = {}) {
  const startedAt = nowFn();
  const gap = Number.isFinite(Number(gapMs)) ? Math.max(0, Number(gapMs)) : 0;
  if (gap > 0) {

    const jitter = Math.floor(Math.random() * Math.max(1, Math.round(gap * jitterRatio)));
    const nap = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    for (;;) {
      const last = readLast(key, nowFn());
      if (!last) break;
      const remain = last + gap + jitter - nowFn();
      if (remain <= 0) break;
      await nap(Math.min(remain, 500));
    }
  }
  record(key, nowFn());
  return nowFn() - startedAt;
}

module.exports = { waitGap, readLast, record, filePath };
