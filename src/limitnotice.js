const HINT = /制限|limit|limited|restrict|quality|品質|限制|降低|upgrade|アップグレード|升級/i;

const PATTERNS = [
  /(\d{1,2}):(\d{2})\s*(?:まで|迄)/,
  /(?:until|at|by)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i,
  /(?:到|至)\s*(\d{1,2}):(\d{2})/,
];

function parseLimitNotice(texts, now = Date.now()) {
  const list = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t || '')).filter(Boolean);
  const hit = list.find((t) => HINT.test(t));
  if (!hit) return null;
  for (const re of PATTERNS) {
    const m = re.exec(hit);
    if (!m) continue;
    let h = Number(m[1]);
    const mi = Number(m[2] || 0);
    const ampm = (m[3] || '').toLowerCase();
    if (!(h >= 0 && h <= 23) || !(mi >= 0 && mi <= 59)) continue;
    if (ampm === 'pm' && h < 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    const d = new Date(now);
    d.setHours(h, mi, 0, 0);
    let until = d.getTime();

    if (until < now - 5 * 60 * 1000) until += 24 * 60 * 60 * 1000;
    return { text: hit, until, hhmm: `${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}` };
  }
  return { text: hit, until: null, hhmm: '' };
}

module.exports = { parseLimitNotice, HINT, PATTERNS };
