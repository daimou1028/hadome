const fs = require('fs');
const os = require('os');
const path = require('path');

const MAX_RECORDS = 30;

function fileOf() {
  return process.env.CHATGPT_BRIDGE_STREAM_CUTS
    ? path.resolve(process.env.CHATGPT_BRIDGE_STREAM_CUTS)
    : path.join(os.homedir(), '.chatgpt-bridge', 'stream-cuts.json');
}

function readAll() {
  try {
    const o = JSON.parse(fs.readFileSync(fileOf(), 'utf8'));
    return o && Array.isArray(o.records) ? o : { records: [] };
  } catch {

    return { records: [] };
  }
}

function noteStreamCut(rec, when) {
  if (!rec || typeof rec !== 'object') return null;
  try {
    const o = readAll();
    o.records.push({
      at: when || new Date().toISOString(),
      why: String(rec.why || '').slice(0, 40),
      status: Number(rec.status) || 0,
      ms: Number(rec.ms) || 0,
      events: Number(rec.events) || 0,
      bytes: Number(rec.bytes) || 0,
      chars: Number(rec.chars) || 0,
      complete: rec.complete === true,

      url: String(rec.url || '').slice(0, 200),
      message: rec.message ? String(rec.message).slice(0, 300) : undefined,
      head: Array.isArray(rec.head) ? rec.head.slice(0, 12) : [],
      tail: Array.isArray(rec.tail) ? rec.tail.slice(0, 12) : [],
    });
    if (o.records.length > MAX_RECORDS) o.records.splice(0, o.records.length - MAX_RECORDS);
    const f = fileOf();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, JSON.stringify(o, null, 1));
    return o.records.length;
  } catch {
    return null;
  }
}

function listStreamCuts() {
  return readAll().records.slice().reverse();
}

module.exports = { noteStreamCut, listStreamCuts, fileOf, MAX_RECORDS };
