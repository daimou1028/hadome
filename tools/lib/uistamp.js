const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..');

const { PARTS } = require('../../src/panelmark');

const STAMPS = {
  interact: path.join(ROOT, 'docs', 'evidence', 'ui-interact-stamp.json'),
  baseline: path.join(ROOT, 'docs', 'evidence', 'ui-baseline-stamp.json'),
  metrics: path.join(ROOT, 'docs', 'evidence', 'ui-metrics-stamp.json'),
};
const STAMP = STAMPS.interact;

const MARK = /\nwindow\.__BUNDLE__ = "[0-9a-f]*";\n$/;

function fingerprint() {
  const h = crypto.createHash('sha256');
  for (const p of PARTS) {
    h.update(path.relative(ROOT, p));
    const body = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '(無い)';
    h.update(Buffer.from(String(body).replace(MARK, ''), 'utf8'));
  }
  return h.digest('hex').slice(0, 16);
}

function pathFor(which) {
  const p = STAMPS[which || 'interact'];
  if (!p) throw new Error(`知らない録りの名前: ${which}`);
  return p;
}

function write({ passed, total, at, which }) {
  const out = pathFor(which);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(
    out,
    JSON.stringify({ 指紋: fingerprint(), 通った: passed, 全部: total, いつ: at }, null, 2) + '\n'
  );
  return out;
}

function read(which) {
  const p = pathFor(which);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) {
    return null;
  }
}

module.exports = { fingerprint, write, read, STAMP, STAMPS, pathFor };
