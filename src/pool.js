const DEFAULT_BASE = 8810;

const DEFAULT_MAX = 2;

const DEFAULT_STAGGER_MS = 1500;

function makePool({
  base = DEFAULT_BASE,
  max = DEFAULT_MAX,
  openBridge,
  openTab,
  closeTab,
  staggerMs = DEFAULT_STAGGER_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
} = {}) {
  if (typeof openBridge !== 'function')
    throw new Error('openBridge が要ります');
  const inUse = new Map();

  function freePort() {
    for (let p = base; p < base + max; p += 1) if (!inUse.has(p)) return p;
    return null;
  }

  async function take(name) {
    const port = freePort();
    if (port === null) return null;

    inUse.set(port, { bridge: null, name: String(name || '') });
    try {

      if (staggerMs && inUse.size > 1) await sleep(staggerMs);
      if (openTab) await openTab(port);
      const bridge = await openBridge(port);
      inUse.get(port).bridge = bridge;
      return { port, bridge, name: String(name || '') };
    } catch (e) {
      inUse.delete(port);
      throw e;
    }
  }

  function give(port) {
    const held = inUse.get(port);
    if (!held) return false;
    inUse.delete(port);

    if (closeTab) {
      try {
        const r = closeTab(port, held);
        if (r && typeof r.catch === 'function') r.catch(() => {});
      } catch {

      }
    }
    try {
      if (held.bridge && held.bridge.close) held.bridge.close();
    } catch {

    }
    return true;
  }

  function giveAll() {
    let n = 0;
    for (const port of [...inUse.keys()]) if (give(port)) n += 1;
    return n;
  }

  return {
    take,
    give,
    giveAll,
    max,
    base,
    inUseCount: () => inUse.size,
    ports: () => [...inUse.keys()].sort((a, b) => a - b),
    names: () => [...inUse.values()].map((v) => v.name),
  };
}

module.exports = { makePool, DEFAULT_BASE, DEFAULT_MAX, DEFAULT_STAGGER_MS };
