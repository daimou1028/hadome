const DEFAULT_LIMIT = 4;

function makeSubagents({ pool, runOne, onProgress = () => {}, limit = DEFAULT_LIMIT } = {}) {
  if (!pool) throw new Error('pool が要ります');
  if (typeof runOne !== 'function') throw new Error('runOne が要ります');

  async function run(tasks) {
    const wanted = (Array.isArray(tasks) ? tasks : [])
      .map((t) => String(t == null ? '' : t).trim())
      .filter(Boolean);
    if (wanted.length === 0) return { results: [], skipped: [], why: 'tasks がありません' };

    const take = wanted.slice(0, limit);
    const skipped = wanted.slice(limit);

    const results = await Promise.all(
      take.map(async (task, i) => {
        const name = `サブエージェント ${i + 1}`;

        const at = i + 1;
        let slot = null;
        try {
          slotOf.set(name, at);
          onProgress({ name, at, stateKey: 'waiting' });
          slot = await pool.take(name);
          if (!slot) return { name, task, ok: false, why: '空いている場所がありません' };
          onProgress({ name, at, stateKey: 'started' });

          const text = await runOne({ bridge: slot.bridge, task, name, at });
          onProgress({ name, at, stateKey: 'done', text });
          return { name, task, ok: true, text: String(text || '') };
        } catch (e) {

          onProgress({ name, at, stateKey: 'failed', text: String((e && e.message) || e) });
          return { name, task, ok: false, why: String((e && e.message) || e) };
        } finally {
          if (slot) pool.give(slot.port);
        }
      })
    );

    return { results, skipped };
  }

  const slotOf = new Map();
  function tick(name, turn, of) {
    const at = slotOf.get(name) || null;
    onProgress({ name, at, stateKey: 'running', turn, of });
  }

  return { run, limit, tick };
}

const PER_AGENT_LIMIT_CHARS = 12000;

function clipOne(text, limit = PER_AGENT_LIMIT_CHARS) {
  const t = String(text || '');
  if (t.length <= limit) return t;
  return (
    t.slice(0, limit) +
    `\n\n…（ここで切りました。このサブエージェントは ${t.length} 文字書きましたが、` +
    `${limit} 文字までにしています。足りなければ、範囲を絞って頼み直してください）`
  );
}

function formatSubagentResults({ results, skipped }) {
  const out = [];
  for (const r of results) {
    out.push(`--- ${r.name} ---`);
    out.push(`依頼: ${r.task}`);
    out.push(r.ok ? clipOne(r.text) : `失敗: ${r.why}`);
    out.push('');
  }
  if (skipped && skipped.length) {
    out.push(`※ 一度に受けられる数を超えたので、次の ${skipped.length} 件は走らせていません:`);
    for (const s of skipped) out.push(`  - ${s}`);
    out.push('必要なら、あらためて頼んでください。');
  }
  return out.join('\n').trim();
}

module.exports = { makeSubagents, formatSubagentResults, clipOne, DEFAULT_LIMIT, PER_AGENT_LIMIT_CHARS };
