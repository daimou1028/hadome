const KEY = 'chatgptBridge.dedicatedProject';

function readProjectMemo(store, pluginId) {
  const id = String(pluginId || '').trim();
  if (!store || !id) return null;
  const all = store.get(KEY, null);
  if (!all || typeof all !== 'object' || Array.isArray(all)) return null;
  if (Object.prototype.hasOwnProperty.call(all, 'id')) return null;
  const memo = all[id];
  if (!memo || typeof memo !== 'object' || !memo.id) return null;
  return { id: String(memo.id), name: String(memo.name || '') };
}

async function writeProjectMemo(store, pluginId, memo) {
  const id = String(pluginId || '').trim();
  if (!store || !id || !memo || !memo.id) return;
  const all = store.get(KEY, null);
  const next = all && typeof all === 'object' && !Array.isArray(all) && !Object.prototype.hasOwnProperty.call(all, 'id')
    ? { ...all }
    : {};
  next[id] = { id: String(memo.id), name: String(memo.name || '') };
  await store.update(KEY, next);
}

async function forgetProjectMemo(store, pluginId) {
  const id = String(pluginId || '').trim();
  if (!store || !id) return;
  const all = store.get(KEY, null);
  if (!all || typeof all !== 'object' || Array.isArray(all) || Object.prototype.hasOwnProperty.call(all, 'id')) return;
  if (!Object.prototype.hasOwnProperty.call(all, id)) return;
  const next = { ...all };
  delete next[id];
  await store.update(KEY, next);
}

module.exports = { readProjectMemo, writeProjectMemo, forgetProjectMemo };
