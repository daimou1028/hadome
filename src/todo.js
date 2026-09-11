const MAX_TODOS = 40;

const STATUS = ['pending', 'in_progress', 'completed'];

function normalizeTodos(raw) {
  if (!Array.isArray(raw)) {
    return { ok: false, why: 'todos は配列で渡してください' };
  }
  if (raw.length > MAX_TODOS) {
    return { ok: false, why: `やることが多すぎます（${raw.length} 件。${MAX_TODOS} 件まで）` };
  }
  const out = [];
  const seen = new Set();
  for (const t of raw) {

    const content = String((t && (t.content || t.step || t.task || t.text)) || '').trim();
    if (!content) continue;

    if (seen.has(content)) continue;
    seen.add(content);
    let status = String((t && t.status) || 'pending').trim();
    if (!STATUS.includes(status)) status = 'pending';
    out.push({
      content,
      status,

      activeForm: String((t && t.activeForm) || '').trim() || content,
    });
  }
  if (!out.length) return { ok: false, why: 'やることが 1 件もありません' };

  const running = out.filter((t) => t.status === 'in_progress');
  if (running.length > 1) {
    let first = true;
    for (const t of out) {
      if (t.status !== 'in_progress') continue;
      if (first) {
        first = false;
        continue;
      }
      t.status = 'pending';
    }
  }
  return { ok: true, todos: out, fixed: running.length > 1 };
}

function todoCount(todos) {
  const list = Array.isArray(todos) ? todos : [];
  return {
    done: list.filter((t) => t.status === 'completed').length,
    all: list.length,

    now: (list.find((t) => t.status === 'in_progress') || {}).activeForm || '',
  };
}

module.exports = { normalizeTodos, todoCount, MAX_TODOS, STATUS };
