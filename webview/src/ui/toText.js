const MAX = 300;

function toText(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);

  try {
    const s = JSON.stringify(v);
    return s.length > MAX ? s.slice(0, MAX) + '…' : s;
  } catch (e) {

    return String(v);
  }
}

module.exports = { toText, MAX };
