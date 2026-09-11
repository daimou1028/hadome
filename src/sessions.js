const JA_FALLBACK = {
  'se.badName': ({ name }) => `名前の形が違います: ${name}`,
  'se.noTitle': () => '（まだ何も頼んでいません）',
  'se.broken': () => 'セッションの形が壊れています',
  'se.emptyTask': () => '（空の依頼）',
};
let tIn = null;

function useTranslator(fn) {
  tIn = fn;
}
const t = (k, v) => (tIn ? tIn(k, v) : JA_FALLBACK[k](v || {}));

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 1000;

function dirOf(root) {
  return path.join(root, 'sessions');
}

function ensureDir(root) {
  const d = dirOf(root);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function newId(nowMs) {
  const d = new Date(nowMs);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

function fileOf(root, id) {

  if (!/^[0-9]{8}-[0-9]{6}$/.test(String(id))) throw new Error(t('se.badName', { name: id }));
  return path.join(dirOf(root), `${id}.json`);
}

function create(root, { workspace, nowMs }) {
  ensureDir(root);
  return {
    id: newId(nowMs),
    workspace,
    title: t('se.noTitle'),
    createdAt: nowMs,
    updatedAt: nowMs,
    conversationUrl: '',
    conversationId: '',
    entries: [],

    dropped: 0,
  };
}

function save(root, session) {
  ensureDir(root);
  fs.writeFileSync(fileOf(root, session.id), JSON.stringify(session, null, 2), 'utf8');
  return session;
}

function load(root, id) {
  const raw = fs.readFileSync(fileOf(root, id), 'utf8');
  const s = JSON.parse(raw);
  if (!Array.isArray(s.entries)) throw new Error(t('se.broken'));
  return s;
}

function remove(root, id) {
  try {
    fs.unlinkSync(fileOf(root, id));
    return true;
  } catch {
    return false;
  }
}

function removeAll(root, { workspace } = {}) {
  const targets = list(root, { workspace });
  let removed = 0;
  for (const s of targets) {
    if (remove(root, s.id)) removed += 1;
  }

  const left = list(root, { workspace }).length;
  return { removed, left };
}

function samePath(a, b) {
  return String(a || '').normalize('NFC') === String(b || '').normalize('NFC');
}

function list(root, { workspace } = {}) {
  let names;
  try {
    names = fs.readdirSync(dirOf(root));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    try {
      const s = JSON.parse(fs.readFileSync(path.join(dirOf(root), n), 'utf8'));

      if (workspace && !samePath(s.workspace, workspace)) continue;
      out.push({
        id: s.id,
        title: s.title,
        workspace: s.workspace,
        updatedAt: s.updatedAt,
        count: Array.isArray(s.entries) ? s.entries.length : 0,
        conversationUrl: s.conversationUrl || '',
        conversationId: s.conversationId || '',
      });
    } catch {

    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

const STAMPED = new Set([
  'limits',
  'model',
  'autoswitch',
  'note',
]);

function append(session, entry, nowMs) {

  if (STAMPED.has(entry.type) && entry.at === undefined && nowMs) entry.at = nowMs;
  session.entries.push(entry);

  while (session.entries.length > MAX_ENTRIES) {
    session.entries.shift();
    session.dropped = (session.dropped || 0) + 1;
  }
  session.updatedAt = nowMs;
  if (entry.type === 'you' && !session.titleFixed) {
    session.title = String(entry.text || '').replace(/\s+/g, ' ').slice(0, 60) || t('se.emptyTask');
    session.titleFixed = true;
  }
  return session;
}

function answerLastAsk(session, answer, { kind = null } = {}) {
  if (!session || !Array.isArray(session.entries)) return null;
  for (let i = session.entries.length - 1; i >= 0; i -= 1) {
    const e = session.entries[i];
    if (!e || e.type !== 'ask') continue;
    if (e.answered !== undefined) continue;
    if (kind && e.kind && e.kind !== kind) continue;
    e.answered = String(answer == null ? '' : answer);
    return e;
  }
  return null;
}

function findByConversationId(root, id) {
  if (!id) return null;
  for (const item of list(root)) {
    if (item.conversationId === id) return item;
  }
  return null;
}

module.exports = {
  answerLastAsk,
  removeAll,
  samePath,
  useTranslator,
  create,
  save,
  load,
  list,
  remove,
  append,
  dirOf,
  newId,
  findByConversationId,
  MAX_ENTRIES,
};
