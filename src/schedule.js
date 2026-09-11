const MAX = 20;

function makeSchedule({ now = () => Date.now(), max = MAX } = {}) {
  let items = [];
  let seq = 0;

  function add(text, at) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { ok: false, why: 'empty' };
    const when = Number(at);
    if (!Number.isFinite(when)) return { ok: false, why: 'when' };
    if (when <= now()) return { ok: false, why: 'past' };
    if (items.length >= max) return { ok: false, why: 'full' };
    seq += 1;
    const item = { id: `s${seq}`, text: t, at: when };
    items.push(item);
    items.sort((a, b) => a.at - b.at);
    return { ok: true, item };
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((x) => x.id !== id);
    return items.length !== before;
  }

  function due() {
    const t = now();
    const ready = items.filter((x) => x.at <= t);
    if (ready.length) items = items.filter((x) => x.at > t);
    return ready;
  }

  function dump() {
    return items.map((x) => ({ id: x.id, text: x.text, at: x.at }));
  }

  function restore(saved) {
    const t = now();
    const rows = Array.isArray(saved) ? saved : [];
    items = rows
      .filter((x) => x && typeof x.text === 'string' && Number(x.at) > t)
      .slice(0, max)
      .map((x) => ({ id: String(x.id || ''), text: x.text, at: Number(x.at) }));
    items.sort((a, b) => a.at - b.at);

    for (const x of items) {
      const n = Number(String(x.id).replace(/^s/, ''));
      if (Number.isFinite(n) && n > seq) seq = n;
    }
    return items.length;
  }

  return {
    add,
    remove,
    due,
    dump,
    restore,
    list: () => items.slice(),
    isEmpty: () => items.length === 0,
  };
}

module.exports = { makeSchedule, MAX };
