'use strict';

function pathOf(url) {
  try {
    return new URL(String(url || '')).pathname;
  } catch {
    return '';
  }
}

function rememberable(url) {

  const u = String(url || '');
  const p = pathOf(u) || (u.startsWith('/') ? u.split(/[?#]/)[0] : '');
  return /\/c\/[^/?#]+/.test(p);
}

function pathHits(href, want) {
  const w = String(want || '');
  if (!w) return false;
  if (w !== '/') return String(href || '').includes(w);
  const p = pathOf(href) || String(href || '');
  return p === '/';
}

function brandOf(ua) {
  const s = String(ua || '');

  const hit = [
    [/Edg\/(\d+)/, 'Edge'],
    [/OPR\/(\d+)/, 'Opera'],
    [/Chrome\/(\d+)/, 'Chrome'],
  ].find(([re]) => re.test(s));
  if (!hit) return '';
  return `${hit[1]} ${hit[0].exec(s)[1]}`;
}

function buildChoices({ rosters = [], editorId = '', wanted = null, now = Date.now(), staleMs = 3 * 60 * 1000 } = {}) {
  const groups = [];
  const selectable = [];
  for (const r of Array.isArray(rosters) ? rosters : []) {
    if (!r || typeof r !== 'object') continue;
    if (Number(r.at) > 0 && now - Number(r.at) > staleMs) continue;
    const pluginId = String(r.pluginId || '');
    const windows = [];
    for (const w of Array.isArray(r.windows) ? r.windows : []) {
      const tabs = [];
      for (const t of w && Array.isArray(w.tabs) ? w.tabs : []) {
        if (!t || t.kind === 'subagent') continue;
        const path = pathOf(t.url);
        const heldBy = t.claimedBy && t.claimedBy !== editorId ? String(t.claimedBy) : '';
        const choice = {
          value: { pluginId, url: path, chromeTabId: Number.isInteger(t.chromeTabId) ? t.chromeTabId : null },
          title: String(t.title || ''),
          path,

          disabled: !!heldBy || !pluginId,
          heldBy,
          warnBackground: t.visible === false,
        };
        tabs.push(choice);
        if (!choice.disabled) selectable.push(choice);
      }
      if (tabs.length) windows.push({ windowId: String((w && w.windowId) || ''), tabs });
    }
    if (windows.length) groups.push({ pluginId, brand: brandOf(r.browser && r.browser.ua), windows });
  }

  if (wanted && wanted.url && rememberable(wanted.url)) {
    const samePlugin = (c) => !wanted.pluginId || c.value.pluginId === wanted.pluginId;
    const byPath = selectable.filter((c) => samePlugin(c) && c.path && pathHits(c.path, wanted.url));
    const byId = Number.isInteger(wanted.chromeTabId) ? byPath.filter((c) => c.value.chromeTabId === wanted.chromeTabId) : [];
    const hit = byId.length === 1 ? byId[0] : byPath.length === 1 ? byPath[0] : null;
    if (hit) return { ask: false, why: 'remembered', pick: hit.value, groups, selectable: selectable.length };
  }
  if (selectable.length === 0) return { ask: false, why: 'none', pick: null, groups, selectable: 0 };
  if (selectable.length === 1) return { ask: false, why: 'single', pick: selectable[0].value, groups, selectable: 1 };
  return { ask: true, why: 'choose', pick: null, groups, selectable: selectable.length };
}

function labelsOf(groups, { currentChromeTabId = null, currentPluginId = '', words = {} } = {}) {
  const word = { window: 'Window', tab: 'Tab', current: 'current target', background: 'background', ...words };
  const items = [];
  for (const group of Array.isArray(groups) ? groups : []) {

    const brand = String(group.brand || '') || String(group.pluginId || '').slice(0, 8);
    (Array.isArray(group.windows) ? group.windows : []).forEach((win, i) => {
      for (const tab of Array.isArray(win.tabs) ? win.tabs : []) {
        if (!tab || tab.disabled) continue;

        const head = `${brand} — ${word.window} ${i + 1} — ${tab.title || tab.path || ''} — ${tab.path || ''}`;
        items.push({ head, tab });
      }
    });
  }
  const total = new Map();
  for (const x of items) total.set(x.head, (total.get(x.head) || 0) + 1);
  const seen = new Map();
  return items.map(({ head, tab }) => {
    let label = head;
    if (total.get(head) > 1) {
      seen.set(head, (seen.get(head) || 0) + 1);
      label += ` — ${word.tab} ${seen.get(head)}`;
    }

    const id = tab.value && tab.value.chromeTabId;

    const samePlugin = !!currentPluginId && String((tab.value && tab.value.pluginId) || '') === currentPluginId;
    if (Number.isInteger(id) && Number.isInteger(currentChromeTabId) && id === currentChromeTabId && samePlugin) label += ` — ${word.current}`;
    if (tab.warnBackground) label += ` — ⚠ ${word.background}`;
    return { label, value: tab.value };
  });
}

module.exports = { buildChoices, brandOf, pathOf, labelsOf, rememberable, pathHits };
