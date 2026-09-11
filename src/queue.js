const MAX = 20;

function makeQueue({ now = () => Date.now(), max = MAX } = {}) {
  let items = [];
  let seq = 0;

  function route(busy, text) {
    if (!busy) return { as: 'run' };
    const r = add(text);
    if (r.ok) return { as: 'queued', item: r.item };
    return { as: r.why === 'full' ? 'full' : 'empty' };
  }

  function add(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return { ok: false, why: 'empty' };
    if (items.length >= max) return { ok: false, why: 'full' };
    seq += 1;
    const item = { id: `q${seq}`, text: t, timestamp: now() };
    items.push(item);
    return { ok: true, item };
  }

  function remove(id) {
    const before = items.length;
    items = items.filter((x) => x.id !== id);
    return items.length !== before;
  }

  function update(id, text) {
    const t = String(text == null ? '' : text).trim();
    const at = items.findIndex((x) => x.id === id);
    if (at < 0) return false;
    if (!t) {
      items.splice(at, 1);
      return true;
    }
    items[at] = { ...items[at], text: t, timestamp: now() };
    return true;
  }

  function next() {
    return items.length ? items.shift() : null;
  }

  function list() {
    return items.map((x) => ({ ...x }));
  }

  function clear() {
    const n = items.length;
    items = [];
    return n;
  }

  return { route, add, remove, update, next, list, clear, isEmpty: () => items.length === 0, max };
}

module.exports = { makeQueue, MAX };
